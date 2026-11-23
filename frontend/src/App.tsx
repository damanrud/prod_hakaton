import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { questions, duelExtras } from "./questions";
import { CarDetails, Icon, Modal, TextSection, Home, Quiz, StartButton, ResultCard, CompareContent,
  valuesOf, cloneAnswers, removeStaleExtras, titleOfAnswer,
  carName, type Answers, type Car, type Results, type Explanation, type HomePick } from "./format";
import { makeResultImage } from "./share";

type Screen = "home" | "quiz" | "loading" | "results";
type DialogType = "car" | "compare" | "edit" | "share" | null;
const STORAGE_KEY="autochoice-quiz-v1";
// Тема хранится отдельно от анкеты; при первом посещении используется системная настройка.
type Theme = "light" | "dark";
const THEME_KEY = "autochoice-theme-v1";
function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch { /* В приватном режиме доступ к хранилищу может быть ограничен. */ }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
/** Запрос с единым обработчиком ошибок; все рекомендации и веса считает только Flask. */
async function apiPost<T>(url:string,payload:object,signal?:AbortSignal):Promise<T>{
  const deadline = AbortSignal.timeout(12000);
  const boundedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const response=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),signal:boundedSignal});
  const data=await response.json().catch(()=>{throw new Error("Сервер вернул некорректный ответ. Попробуй ещё раз.");});
  if(!response.ok)throw new Error(data.message||`Ошибка сервера: ${response.status}`);
  return data as T;
}

function initialProgress():{answers:Answers;index:number;completed:boolean}{
  try{const value=JSON.parse(localStorage.getItem(STORAGE_KEY)||"null");
    if(value&&typeof value==="object"&&value.answers&&typeof value.answers==="object"&&!Array.isArray(value.answers))return {
      answers:value.answers,index:Number.isInteger(value.index)&&value.index>=0&&value.index<15?value.index:0,
      completed:value.completed===true};}catch{/* История браузера может быть недоступна. */}
  return {answers:{},index:0,completed:false};
}
// ───────────── БЛОК 4. Главный компонент объединяет этапы приложения ─────────────
export default function App(){
  // Анкета: ответы, текущий вопрос и черновик для изменения без потери данных.
  const [saved]=useState(initialProgress);
  const [answers,setAnswers]=useState<Answers>(saved.answers);
  const [index,setIndex]=useState(saved.index);
  const [completed,setCompleted]=useState(saved.completed);
  const [draft,setDraft]=useState<Answers>(cloneAnswers(saved.answers));
  const [editing,setEditing]=useState(false);
  const [screen,setScreen]=useState<Screen>("home");
  // Одна тема на всех экранах, включая модальные окна, опрос и сравнение.
  const [theme,setTheme]=useState<Theme>(readTheme);
  const [quizError,setQuizError]=useState("");
  const [serverError,setServerError]=useState("");
  // Полученные с Python рекомендации (никаких локальных формул на React).
  const [results,setResults]=useState<Results|null>(null);
  const [homePicks,setHomePicks]=useState<HomePick[]>([]);
  const [duels,setDuels]=useState<Record<string,Record<string,string>>>({});
  const [duelsLoading,setDuelsLoading]=useState(false);
  // Кэш по рациональным ответам исключает ненужные повторные запросы.
  const duelCache=useRef(new Map<string,Record<string,Record<string,string>>>());
  const [catalog,setCatalog]=useState<Car[]>([]);
  const [search,setSearch]=useState("");const [selectedCarId,setSelectedCarId]=useState("");
  const [suggestionsOpen,setSuggestionsOpen]=useState(false);
  const [activeSuggestion,setActiveSuggestion]=useState(-1);
  const [explainError,setExplainError]=useState("");const [explainLoading,setExplainLoading]=useState(false);
  // ID выбранных машин для сравнения: максимум три разных ID.
  const [compared,setCompared]=useState<string[]>([]);const [compareNotice,setCompareNotice]=useState("");
  const [dialog,setDialog]=useState<DialogType>(null);
  const [detailCar,setDetailCar]=useState<Car|null>(null);
  const [detailRanked,setDetailRanked]=useState(false); // Для готовых примеров не показываем персональный балл.
  const [explanation,setExplanation]=useState<Explanation|null>(null);
  const [preview,setPreview]=useState("");const [imageBlob,setImageBlob]=useState<Blob|null>(null);const [shareMessage,setShareMessage]=useState("");
  const [busyStart,setBusyStart]=useState(false);const [finishCelebration,setFinishCelebration]=useState(false);
  const [contractError,setContractError]=useState("");
  // Отмена устаревших HTTP-запросов и защита от двойного запуска анимации.
  const requestRef=useRef<AbortController|null>(null),explainRef=useRef<AbortController|null>(null),startLock=useRef(false);
  const visualPhase=index>=10;
  const firstTen=JSON.stringify(Object.fromEntries(Object.entries(answers).filter(([key])=>Number(key)<=10||["budgetMax","minSeats","engine","hybrid"].includes(key))));
  // Кнопки на всех экранах используют тот же текст, что и исходный JavaScript.
  const hasProgress=index>0||Object.keys(answers).length>0;
  const startLabel=completed?"Открыть мой подбор":hasProgress?"Продолжить подбор":"Начать подбор";

  useEffect(()=>{document.body.dataset.screen=screen;window.scrollTo(0,0);},[screen,index]);
  useEffect(()=>{
    document.documentElement.dataset.theme=theme;
    document.documentElement.style.colorScheme=theme;
    const themeMeta=document.querySelector('meta[name="theme-color"]');
    themeMeta?.setAttribute("content",theme==="dark"?"#0b1222":"#f7f9fc");
    try{localStorage.setItem(THEME_KEY,theme);}catch{/* Без localStorage переключатель работает до перезагрузки. */}
  },[theme]);
  useEffect(()=>{try{localStorage.setItem(STORAGE_KEY,JSON.stringify({answers,index,completed}));}catch{}},[answers,index,completed]);
  // При запуске один раз сверяем варианты вопросов с серверным контрактом.
  // Нет ни интервала, ни запросов при каждом ответе — исключаем рассинхронизацию UI и API.
  useEffect(()=>{
    const controller=new AbortController();
    fetch("/api/question-contract",{signal:controller.signal}).then(response=>{
      if(!response.ok)throw new Error("Контракт API недоступен");
      return response.json();
    }).then(contract=>{
      const changed=questions.some((question,index)=>{
        const known=contract.questions?.[String(index+1)];
        const expected=[...question.options,...(index>=10?duelExtras:[])].map(option=>option[0]).sort();
        const received=Array.isArray(known?.values)?[...known.values].sort():[];
        return JSON.stringify(expected)!==JSON.stringify(received)||Boolean(question.multi)!==Boolean(known?.multi);
      });
      if(changed)setContractError("Версии анкеты и API различаются. Обнови страницу или обратись к разработчику.");
    }).catch(error=>{if(!controller.signal.aborted)setContractError(String(error.message||error));});
    return()=>controller.abort();
  },[]);
  useEffect(()=>{const a=new AbortController();fetch("/api/home-picks",{signal:a.signal}).then(r=>r.ok?r.json():Promise.reject()).then(d=>setHomePicks(d.picks||[])).catch(()=>{});return()=>a.abort();},[]);
  useEffect(()=>()=>{requestRef.current?.abort();explainRef.current?.abort();if(preview)URL.revokeObjectURL(preview);},[preview]);
  useEffect(()=>{
    if(screen!=="quiz"||!visualPhase)return;
    const cached=duelCache.current.get(firstTen);
    if(cached){setDuels(cached);setDuelsLoading(false);return;}
    const controller=new AbortController();
    setDuels({});setDuelsLoading(true);
    apiPost<{duels:Record<string,Record<string,string>>}>("/api/duels",{answers:JSON.parse(firstTen)},controller.signal)
      .then(data=>{
        if(controller.signal.aborted)return;
        const pairs=data.duels||{};
        duelCache.current.set(firstTen,pairs);setDuels(pairs);
      })
      .catch(()=>{if(!controller.signal.aborted){duelCache.current.set(firstTen,{});setDuels({});}})
      .finally(()=>{if(!controller.signal.aborted)setDuelsLoading(false);});
    return()=>controller.abort();
  },[screen,visualPhase,firstTen]);
  useEffect(()=>{if(screen!=="results"||catalog.length)return;
    const a=new AbortController();fetch("/api/cars",{signal:a.signal}).then(r=>r.ok?r.json():Promise.reject()).then(d=>setCatalog(d.cars||[])).catch(()=>setExplainError("Каталог временно недоступен."));return()=>a.abort();},[screen,catalog.length]);

  const requestResults=useCallback(async(finished=false,nextAnswers?:Answers)=>{
    const current=nextAnswers||answers;requestRef.current?.abort();const controller=new AbortController();requestRef.current=controller;
    setServerError("");setResults(null);setCompared([]);setScreen("loading");setFinishCelebration(finished);
    // Короткая демонстрация загрузки параллельна запросу, не блокирует сервер.
    // После последнего вопроса сохраняем анимацию приборной панели на 2 секунды.
    const minDuration=finished&&!window.matchMedia("(prefers-reduced-motion: reduce)").matches?2000:0;
    const minDelay=new Promise<void>(resolve=>setTimeout(resolve,minDuration));
    try{const response=await apiPost<Results>("/api/recommend",{answers:current,balance:50},controller.signal);
      await minDelay;if(controller.signal.aborted)return;
      if (!Array.isArray(response?.picks) || !["matches","no_matches","empty","needs_answers"].includes(response.status)) throw new Error("Не удалось прочитать результат подбора.");
      setResults(response);setScreen("results");
    }catch(error){if(controller.signal.aborted)return;setServerError(error instanceof Error?error.message:"Не удалось получить подбор");setScreen("results");}
    finally{if(requestRef.current===controller)requestRef.current=null;}
  },[answers]);

  function showQuestion(position:number,asEdit=false){requestRef.current?.abort();setDraft(cloneAnswers(answers));setIndex(position);setEditing(asEdit);setQuizError("");setScreen("quiz");}
  async function start(){if(startLock.current)return;startLock.current=true;setBusyStart(true);
    if(!window.matchMedia("(prefers-reduced-motion: reduce)").matches)await new Promise(resolve=>setTimeout(resolve,1000));
    setBusyStart(false);startLock.current=false;
    if(completed){if(results)setScreen("results");else void requestResults(false);}
    else showQuestion(index);
  }
  function validate():string|null{
    const key=String(index+1),v=draft[key];if(!valuesOf(v).length)return "Выбери ответ или нажми «Пропустить».";
    if(index===0&&v==="custom"){
      const n=Number(draft.budgetMax);if(!Number.isSafeInteger(n)||n<1)return "Укажи положительную цену в целых рублях.";
    }
    if(index===4&&v==="six"){
      const n=Number(draft.minSeats??6);if(!Number.isSafeInteger(n)||n<6||n>99)return "Укажи количество мест от 6 до 99.";
    }
    if(index===6&&valuesOf(v).includes("engine")&&!draft.engine)return "Выбери нужный двигатель.";
    return null;
  }
  function moveNext(skip=false){if(!skip){const issue=validate();if(issue){setQuizError(issue);return;}}
    const key=String(index+1);let next=cloneAnswers(draft);if(skip)delete next[key];
    if(next["1"]==="custom")next.budgetMax=Number(next.budgetMax);
    if(next["5"]==="six")next.minSeats=Number(next.minSeats||6);
    next=removeStaleExtras(next);setAnswers(next);setQuizError("");
    if(editing||index===14){setCompleted(true);setEditing(false);void requestResults(!editing,next);}
    else{setIndex(i=>i+1);setDraft(next);}
  }
  function moveBack(){if(editing){setEditing(false);setIndex(14);setScreen("results");return;}
    // Сохраняем заполненные ответы при возврате, но не заставляем отвечать.
    const next=removeStaleExtras(cloneAnswers(draft));setAnswers(next);
    if(index===0){setScreen("home");return;}setIndex(i=>i-1);setDraft(next);setQuizError("");
  }
  /** Возврат к главной не теряет уже выбранный корректный ответ, как в исходном сайте. */
  function goHome(){
    requestRef.current?.abort();explainRef.current?.abort();
    if(screen==="quiz"&&!editing&&!validate())setAnswers(removeStaleExtras(cloneAnswers(draft)));
    setScreen("home");
  }
  function reset(){requestRef.current?.abort();setAnswers({});setDraft({});setIndex(0);setCompleted(false);setDuels({});setDuelsLoading(false);setCompared([]);setResults(null);setEditing(false);setQuizError("");setScreen("quiz");}
  /** Показывает тот же диалог, но без персональных баллов у карточек главной. */
  function openDetail(car:Car,expl:Explanation|null=null,ranked=false){
    setDetailCar(car);setExplanation(expl);setDetailRanked(ranked);setDialog("car");
  }
  function compareToggle(id:string){setCompared(prev=>{
    if(prev.includes(id))return prev.filter(x=>x!==id);
    if(prev.length>=3){setCompareNotice("Для сравнения можно выбрать максимум 3 автомобиля.");return prev;}
    const car=results?.picks.find(p=>p.car.id===id)?.car;
    if(car&&prev.some(other=>{const c=results?.picks.find(p=>p.car.id===other)?.car;return c&&carName(c).toLowerCase()===carName(car).toLowerCase();})){
      setCompareNotice("Эта модель уже выбрана для сравнения.");return prev;}
    setCompareNotice("");return [...prev,id];
  });}
  const comparedCars=useMemo(()=>compared.map(id=>results?.picks.find(p=>p.car.id===id)?.car).filter((c):c is Car=>Boolean(c)),[compared,results]);
  async function explain(){if(!selectedCarId){setExplainError("Сначала выбери автомобиль.");return;}
    explainRef.current?.abort();
    const controller=new AbortController();explainRef.current=controller;
    setExplainLoading(true);setExplainError("");
    try{const data=await apiPost<Explanation>("/api/explain-car",{car_id:selectedCarId,answers,balance:50},controller.signal);
      if(!controller.signal.aborted)openDetail(data.car,data,true);
    }catch(error){if(!controller.signal.aborted)setExplainError(error instanceof Error?error.message:"Не удалось получить объяснение.");}
    finally{if(explainRef.current===controller){setExplainLoading(false);explainRef.current=null;}}
  }
  async function saveResult(){if(!results?.picks.length)return;setShareMessage("");try{
    const blob=await makeResultImage(results);if(preview)URL.revokeObjectURL(preview);const url=URL.createObjectURL(blob);
    setImageBlob(blob);setPreview(url);setDialog("share");
  }catch(error){setShareMessage(error instanceof Error?error.message:"Не удалось создать карточку");}}
  async function exportResult(share:boolean){if(!imageBlob)return;
    if(share&&navigator.share&&navigator.canShare){try{const file=new File([imageBlob],"AutoChoice-result.png",{type:"image/png"});
      if(navigator.canShare({files:[file]})){await navigator.share({files:[file],title:"Мой AutoChoice"});return;}
    }catch(error){if((error as Error).name==="AbortError")return;}}
    const a=document.createElement("a");a.href=preview;a.download="AutoChoice-result.png";a.click();setShareMessage(share?"Файл готов: его можно отправить вручную.":"PNG сохранён.");
  }

  // Подсказки ищут совпадения с началом марки или модели, а не загружают
  // весь каталог при каждом нажатии: 100 автомобилей уже получены одним GET.
  const filteredCatalog=useMemo(()=>{
    const query=search.trim().toLocaleLowerCase("ru");
    if(!query)return [];
    const ordered=catalog.filter(car=>{
      const brand=car.brand.toLocaleLowerCase("ru");
      const model=car.model.toLocaleLowerCase("ru");
      // Один символ ищет сначала по марке: «A» → Audi, а не Toyota Alphard.
      // Начиная со второго символа, можно искать и по самому названию модели.
      return brand.startsWith(query)||carName(car).toLocaleLowerCase("ru").startsWith(query)
        || (query.length >= 2 && model.startsWith(query));
    });
    return ordered.sort((a,b)=>carName(a).localeCompare(carName(b),"ru")).slice(0,8);
  },[catalog,search]);
  function chooseSuggestion(car:Car){
    setSearch(carName(car));setSelectedCarId(car.id);
    setSuggestionsOpen(false);setActiveSuggestion(-1);setExplainError("");
  }
  function searchKeyboard(event:KeyboardEvent<HTMLInputElement>){
    if(event.key==="Escape"){setSuggestionsOpen(false);return;}
    if(event.key==="ArrowDown"||event.key==="ArrowUp"){
      if(!filteredCatalog.length)return;
      event.preventDefault();setSuggestionsOpen(true);
      setActiveSuggestion(previous=>event.key==="ArrowDown"
        ?(previous+1)%filteredCatalog.length
        :(previous-1+filteredCatalog.length)%filteredCatalog.length);
    }
    if(event.key==="Enter"&&suggestionsOpen&&filteredCatalog.length){
      event.preventDefault();chooseSuggestion(filteredCatalog[activeSuggestion>=0?activeSuggestion:0]);
    }
  }
  return <>
    <a className="skip-link" href="#main">К содержимому</a>
    {contractError&&<div role="alert" className="notice form-error">{contractError}</div>}
    <header className="site-header"><div className="shell header-inner">
      <a className="brand" href="/" onClick={e=>{e.preventDefault();goHome();}} aria-label="AutoChoice, главная"><img src="/static/images/mark.svg" alt="" width="38" height="38"/><span>Auto<span>Choice</span></span></a>
      <nav className="home-nav" aria-label="О сервисе"><a href="#catalog">Готовые варианты</a><a href="#how">Как это работает</a></nav>
      <div className="header-actions">
        <button type="button" className="theme-toggle" onClick={()=>setTheme(t=>t==="dark"?"light":"dark")}
          aria-label={theme==="dark"?"Включить светлую тему":"Включить тёмную тему"}
          title={theme==="dark"?"Светлая тема":"Тёмная тема"} aria-pressed={theme==="dark"}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {theme==="dark"?<><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></>
              :<path d="M20.5 15.5A8.5 8.5 0 0 1 8.5 3.5a8.5 8.5 0 1 0 12 12z"/>}
          </svg>
          <span className="theme-toggle-label">{theme==="dark"?"Светлая":"Тёмная"}</span>
        </button>
        <StartButton onStart={start} loading={busyStart} className="button button-outline header-cta">{startLabel}</StartButton>
      </div>
    </div></header>
    <main id="main">
      {screen==="home"&&<Home picks={homePicks} onStart={start} onDetail={openDetail} starting={busyStart} startLabel={startLabel}/>}
      {screen==="quiz"&&<Quiz index={index} draft={draft} onChange={v=>{setDraft(v);setQuizError("");}} onNext={()=>moveNext(false)} onSkip={()=>moveNext(true)} onBack={moveBack} error={quizError} editing={editing} duels={duels} duelsLoading={duelsLoading} duelCacheReady={duelCache.current.has(firstTen)}/>}
      {screen==="loading"&&<section className={`shell loading-screen ${finishCelebration?"is-finishing":""}`} id="loading" style={{"--drive-time":"2000ms"} as CSSProperties}><div className="loading-card">
        <div className="dashboard" aria-hidden="true"><div className="dash-decoration"/><svg className="speedometer" viewBox="0 0 300 170"><path className="gauge-rim" d="M 64 159 A 99 99 0 1 1 236 159"/><path className="gauge-ticks" d="M 74 154 A 88 88 0 1 1 226 154" pathLength="96"/><path className="gauge-run" d="M 86 147 A 74 74 0 1 1 214 147" pathLength="100"/><path className="gauge-needle" d="M 146 110 L 150 38 L 154 110 Z"/><circle className="gauge-hub" cx="150" cy="110" r="7"/></svg><div className="dashboard-road"/></div>
        <h2>Подбираем автомобили</h2><p role="status">Сверяем твои ответы с данными каталога.</p><div className="drive-progress" aria-hidden="true"><span/></div>
      </div></section>}
      {screen==="results"&&<section className="shell results-screen" id="results">
        <div className={`results-heading ${finishCelebration&&results?.status==="matches"?"is-celebrating":""} ${serverError||results?.status!=="matches"?"is-interrupted":""}`}>
          <div className="result-decoration" aria-hidden="true"><span className="finish-line"/><span className="finish-medal"><Icon name="check"/></span>{["one","two","three","four"].map(s=><span className={`confetti confetti-${s}`} key={s}/>)}</div>
          <div className="result-copy">{!serverError&&results?.status==="matches"&&<p className="finish-label" id="finish-label">Опрос пройден</p>}<h2 id="results-title">{serverError?"Подбор прервался":results?.status==="matches"?"Твой подбор готов!":results?.status==="no_matches"?"Не нашли подходящих автомобилей":results?.status==="needs_answers"?"Пока нет рекомендаций":"Каталог пока пуст"}</h2><p id="results-message">{results?.status==="matches"?"Сравни модели и посмотри, почему каждая вошла в подбор.":results?.status==="no_matches"?"Попробуй изменить бюджет, число мест или другие обязательные условия.":results?.status==="needs_answers"?"Все вопросы пропущены. Ответь хотя бы на один — и мы сможем подобрать автомобили.":results?.message||"Твои ответы сохранены."}</p></div>
          <div className="result-actions"><button className="button button-outline" onClick={()=>setDialog("edit")}><Icon name="edit"/>Изменить ответы</button><button className="button button-quiet" onClick={reset}><Icon name="refresh"/>Пройти заново</button></div>
        </div>
        <p className="visually-hidden" role="status">{serverError?"Ошибка подбора":results?.status==="matches"?`Рекомендаций — ${results.picks.length}`:results?.status==="no_matches"?"Подходящих автомобилей нет":results?.status==="needs_answers"?"Для подбора ещё нужны ответы":"Каталог пуст"}</p>
        {serverError&&<div className="notice form-error"><p>{serverError}</p><button className="car-link" onClick={()=>void requestResults(false)}>Повторить попытку</button></div>}
        {results&&<>
          {results.status==="matches"&&results.personalization&&results.personalization.answered<results.personalization.recommended&&
            <p className="result-note profile-confidence-note" role="status"><Icon name="info"/>
              {results.personalization.informative===0
                ?"Недостаточно значимых ответов для персонального рейтинга."
                :`Подбор предварительный: содержательных ответов — ${results.personalization.informative} из 15. Чем больше пожеланий ты укажешь, тем точнее получится сравнить машины.`}
            </p>}
          {results.status==="matches"&&results.notes?.filter(note=>!/(доступн[ыао]|характеристик|полнот|оценк[иа] практики|оценк[иа] стиля)/i.test(note)).map((note,i)=><p key={i} className="result-note"><Icon name="info"/>{note}</p>)}
          {results.status==="matches"&&<div className="result-list">{[...results.picks].sort((a,b)=>({reason:0,balance:1,heart:2}[a.type]-{reason:0,balance:1,heart:2}[b.type])).map(p=><ResultCard key={p.car.id} car={p.car} type={p.type} selected={compared.includes(p.car.id)} onDetail={()=>openDetail(p.car,null,true)} onCompare={()=>compareToggle(p.car.id)}/>)}</div>}
          {results.status==="needs_answers"&&<div className="answers-empty-panel" role="status"><span className="answers-empty-symbol" aria-hidden="true">?</span><div><h3>Расскажи немного о своих пожеланиях</h3><p>Пока не выбран ни один вариант, поэтому рекомендовать конкретную машину было бы случайностью. Вернись к вопросам и отметь хотя бы одно условие — даже этого достаточно для предварительного подбора.</p><button className="button button-primary" onClick={()=>setDialog("edit")}>Выбрать ответ</button></div></div>}
          {results.status==="no_matches"&&<><TextSection title="Какие условия исключили машины" items={results.filters}/><section className="dialog-section compromise-section"><h3>Возможные изменения</h3>
            {results.compromises?.length?<ul>{results.compromises.map((p,i)=><li key={i}>{p.description}. Подходящих моделей — {p.count}. <button className="car-link" onClick={()=>{const next=p.answers as Answers;setAnswers(next);void requestResults(false,next);}}>Применить изменение</button></li>)}</ul>:<p>Изменения одного условия недостаточно.</p>}
          </section></>}
          {results.status==="matches"&&compared.length>0&&<div className="compare-toolbar"><span role="status">{compareNotice||`Выбрано для сравнения · ${compared.length} из 3`}</span>
            {compared.length>=2&&<button className="button button-primary" onClick={()=>setDialog("compare")}>{`Сравнить ${compared.length} ${compared.length===2?"автомобиля":"автомобиля"}`}</button>}
          </div>}
          {results.status==="matches"&&<section className="profile-panel dna-panel"><div className="dna-panel-heading"><span className="dna-panel-icon" aria-hidden="true">✦</span><div><p className="dna-eyebrow">Твой профиль предпочтений</p><h2>Автомобильная ДНК</h2></div></div>
            <p className="dna-lead"><strong>Твоя автомобильная ДНК — это карта личных предпочтений.</strong> Она показывает, какие качества машины тебе ближе: комфорт, практичность, характер и эмоции от поездок. Профиль составлен по твоим ответам и помогает понять баланс между «хочу» и «нужно», чтобы сравнивать автомобили осознаннее.</p>
            <p>{results.dna.status==="preliminary"?"Профиль предварительный. ":""}{results.dna.primary?`Главный приоритет — ${results.dna.primary}.`:""}</p>
            {results.personalization?.preference_answers===0&&<p className="dna-description">ДНК появится, когда укажешь хотя бы одно предпочтение о стиле, комфорте или использовании машины.</p>}
            {results.personalization?.preference_answers!==0&&<div className="dna-grid">{results.dna.traits?.map(t=><div className="dna-item" key={t.label}><span>{t.label}</span><strong>{t.percent}%</strong><div className="dna-track"><span style={{"--percent":`${t.percent}%`} as CSSProperties}/></div></div>)}</div>}
            <p className="dna-description">{results.dna.description}</p>
            {results.picks.some(p=>p.car.total_adjusted!=null)&&<div className="dna-best-car"><span>{results.personalization?.answered===0?"Один из автомобилей по заданным ограничениям":results.personalization&&results.personalization.answered<results.personalization.recommended?"Предварительно наиболее совместим":"Наиболее совместим с твоими ответами"}</span><strong>{carName([...results.picks].sort((a,b)=>(b.car.total_adjusted??-1)-(a.car.total_adjusted??-1))[0].car)}</strong></div>}
            {results.picks.some(p=>p.car.total_adjusted!=null)&&<button className="button button-primary" onClick={()=>void saveResult()}>Сохранить мой результат</button>}
            {results.picks.length>0&&!results.picks.some(p=>p.car.total_adjusted!=null)&&<p className="car-search-lead">Чтобы сохранить персональную карточку, выбери хотя бы одно пожелание, которое можно оценить.</p>}
            {shareMessage&&<p role="status">{shareMessage}</p>}
          </section>}
          {results.status==="matches"&&<section className="profile-panel car-search-panel"><h2>Почему не эта машина?</h2>
            <p className="car-search-description">Понравилась другая модель? Выбери её из каталога — AutoChoice объяснит, соответствует ли она твоим условиям и почему не вошла в рекомендации.</p>
            <div className="car-search-box">
              <label htmlFor="catalog-search">Марка или модель</label>
              <div className="car-search-combobox">
                <input id="catalog-search" className="extra-input car-search-input" type="search"
                  role="combobox" aria-autocomplete="list" aria-controls="catalog-suggestions"
                  aria-expanded={suggestionsOpen&&search.trim().length>0} aria-activedescendant={activeSuggestion>=0&&suggestionsOpen?`catalog-option-${activeSuggestion}`:undefined}
                  value={search} onChange={e=>{setSearch(e.target.value);setSelectedCarId("");setSuggestionsOpen(true);setActiveSuggestion(-1);setExplainError("");}}
                  onFocus={()=>{if(search.trim())setSuggestionsOpen(true);}}
                  onKeyDown={searchKeyboard} onBlur={()=>setSuggestionsOpen(false)}
                  placeholder="Например, Audi или Corolla" autoComplete="off" aria-describedby="catalog-search-help"/>
                {suggestionsOpen&&search.trim()&&<ul className="car-search-suggestions" id="catalog-suggestions" role="listbox">
                  {filteredCatalog.map((car,i)=><li key={car.id} id={`catalog-option-${i}`} role="option" aria-selected={activeSuggestion===i}>
                    <button type="button" className={i===activeSuggestion?"car-search-option is-active":"car-search-option"}
                      onPointerDown={e=>{e.preventDefault();chooseSuggestion(car);}} onClick={()=>chooseSuggestion(car)}>
                      <span>{carName(car)}</span><small>{[car.trim,car.year].filter(Boolean).join(" · ")}</small>
                    </button>
                  </li>)}
                  {filteredCatalog.length===0&&<li className="car-search-empty">Совпадений в каталоге нет</li>}
                </ul>}
              </div>
              <p className="car-search-help" id="catalog-search-help">Начни вводить марку или модель — ниже появятся варианты из каталога.</p>
              {selectedCarId&&<p className="car-search-selected" role="status"><Icon name="check"/>Модель выбрана</p>}
            </div>
            <button className="button button-outline" onClick={()=>void explain()} disabled={explainLoading||!selectedCarId}>{explainLoading?"Анализируем…":"Почему не эта машина?"}</button>
            {explainError&&<p role="status" className="form-error">{explainError}</p>}
          </section>}
        </>}
      </section>}
    </main>
    {dialog==="car"&&detailCar&&<Modal title="Об автомобиле" onClose={()=>setDialog(null)}><CarDetails car={detailCar} explanation={explanation} ranked={detailRanked}/></Modal>}
    {dialog==="compare"&&comparedCars.length>=2&&<Modal title="Сравнение автомобилей" className="compare-dialog" onClose={()=>setDialog(null)}><CompareContent cars={comparedCars} onRemove={id=>{setCompared(v=>v.filter(x=>x!==id));setDialog(null);}}/></Modal>}
    {dialog==="edit"&&<Modal title="Какой ответ изменить?" onClose={()=>setDialog(null)}><ol className="edit-question-list">{questions.map((q,i)=><li key={i}><button className="edit-question" onClick={()=>{setDialog(null);showQuestion(i,true);}}><span className="edit-question-number">{i+1}</span><strong>{q.title}</strong><small className="edit-question-answer">{titleOfAnswer(answers,i)}</small></button></li>)}</ol></Modal>}
    {dialog==="share"&&<Modal title="Мой автомобильный профиль" onClose={()=>setDialog(null)}>{preview&&<img id="result-card-preview" src={preview} alt="Карточка результата AutoChoice" width="1080" height="1350"/>}<div className="share-actions"><button className="button button-primary" onClick={()=>void exportResult(false)}>Скачать PNG</button><button className="button button-outline" onClick={()=>void exportResult(true)}>Поделиться</button></div><p role="status">{shareMessage}</p></Modal>}
  </>;
}
