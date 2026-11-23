import { useEffect, useRef, useState, type ReactNode, type CSSProperties, type KeyboardEvent } from "react";
import { questions, fuels, hybrids, duelExtras, type Option } from "./questions";
export type Answers = Record<string, string | string[] | number>;


// 1. Данные приходят с Flask. Неизвестное значение остаётся null, не нулём.
export interface Car {
  id: string; brand: string; model: string; trim?: string | null; year?: number | null;
  price_rub?: number | null; image_url?: string | null; source?: string | null;
  verified_at?: string | null; data_date?: string | null; description?: string | null;
  rating_provenance?: {safety: string; reliability: string; basis: string; disclaimer: string};
  reasons?: string[]; tradeoffs?: string[]; unknown?: string[]; notes?: string[];
  total?: number | null; total_adjusted?: number | null; reason?: number | null;
  heart?: number | null; reason_adjusted?: number | null; heart_adjusted?: number | null;
  data_coverage?: number | null;
  profile_answer_count?: number; profile_confidence?: number;
  [key: string]: unknown;
}
export interface DnaTrait { label: string; percent: number }
export interface Dna { traits: DnaTrait[]; status: string; primary?: string; description?: string }
export interface Pick { type: "reason" | "heart" | "balance"; car: Car }
export interface Compromise { description: string; count: number; answers: Record<string, unknown> }
export interface Results {
  status: "empty" | "needs_answers" | "no_matches" | "matches";
  message?: string; notes: string[]; count: number;
  picks: Pick[]; dna: Dna; filters: string[]; compromises: Compromise[];
  reason: Car[]; heart: Car[]; balance: Car[];
  personalization?: { answered: number; completed: number; informative: number; constraint_answers: number; recommended: number; confidence: number; preference_answers?: number };
}
export interface Explanation { car: Car; message: string; conditions: {label: string;status: string}[] }
export interface HomePick { title: string; reason: string; car: Car; facts: [string,string | number,string][]; image_url: string | null }

const integerFormat = new Intl.NumberFormat("ru-RU", {maximumFractionDigits: 0});
const decimalFormat = new Intl.NumberFormat("ru-RU", {maximumFractionDigits: 1});
export const fields: Record<string,string> = {
  reason:"Рациональная оценка",heart:"Эмоциональная оценка",total:"Совместимость",completeness:"Полнота данных",
  price_rub:"Ориентировочная цена",trim:"Модификация",year:"Год выпуска",condition:"Состояние",
  safety:"Безопасность (предварительно)",reliability:"Надёжность (предварительно)",
  body_type:"Кузов",car_size:"Размер",seats:"Места",transmission:"Коробка передач",drive:"Привод",
  fuel_type:"Двигатель",hybrid_type:"Тип гибрида",engine_power_hp:"Мощность",boot_l:"Багажник",
  clearance_mm:"Клиренс",fuel_consumption:"Расход топлива"
};
export const labels: Record<string, Record<string,string>> = {
  condition:{new:"Новый",used:"С пробегом"},
  body_type:{sedan:"Седан",hatchback:"Хэтчбек",wagon:"Универсал",liftback:"Лифтбек",coupe:"Купе",convertible:"Кабриолет",crossover:"Кроссовер",suv:"Внедорожник",minivan:"Минивэн",pickup:"Пикап",van:"Фургон",other:"Другой"},
  car_size:{small:"Компактный",medium:"Средний",large:"Большой"},
  transmission:{manual:"Механическая",automatic:"Автоматическая",robot:"Робот",cvt:"Вариатор"},
  drive:{fwd:"Передний",rwd:"Задний",awd:"Полный","4wd":"Полный"},
  fuel_type:{petrol:"Бензиновый",diesel:"Дизельный",hybrid:"Гибридный",electric:"Электрический"},
  hybrid_type:{plug_in:"Подключаемый",regular:"Обычный"}
};
const units: Record<string,string> = {engine_power_hp:"л. с.", boot_l:"л",clearance_mm:"мм",fuel_consumption:"л/100 км"};
export const scoreKeys = ["total","reason","heart","completeness"];
export const specificationKeys = ["year","price_rub","body_type","seats","fuel_type","engine_power_hp","transmission","drive","boot_l","clearance_mm","fuel_consumption",...scoreKeys];
export const carName = (car: Car) => `${car.brand || ""} ${car.model || ""}`.trim();
export const priceText = (value?: number | null) => typeof value === "number" ? `${integerFormat.format(value)} ₽` : "Цена не указана";
export function formatSpec(car: Car, key: string): string {
  // Не используем сырой рейтинг как замену персональному: при одном бюджете
  // сервер специально возвращает total_adjusted=null.
  if (car.profile_answer_count === 0 && ["total", "reason", "heart"].includes(key)) return "";
  const value = key === "total"
    ? ("total_adjusted" in car ? car.total_adjusted : car.total)
    : key === "completeness" ? car.data_coverage : car[key];
  if (value === undefined || value === null || value === "") return "";
  if (key === "price_rub") return priceText(Number(value));
  if (key === "completeness") return `${decimalFormat.format(Number(value)*100)}%`;
  if (key === "year") return String(value);
  if (key === "safety" || key === "reliability") return `${decimalFormat.format(Number(value))} из 5`;
  if (scoreKeys.includes(key)) return `${decimalFormat.format(Number(value))} из 100`;
  if (typeof value === "number") return `${decimalFormat.format(value)}${units[key] ? " " + units[key] : ""}`;
  return labels[key]?.[String(value)] || String(value);
}
export function Icon({name}:{name:string}) { return <svg aria-hidden="true"><use href={`/static/images/ui.svg#${name}`}/></svg>; }
/** Единая фотография автомобиля для светлой и тёмной тем.
 *  object-fit: cover заполняет рамку без боковых белых полос и не растягивает авто.
 *  Исходный файл остаётся нетронутым; центрированное кадрирование делает CSS.
 */
export function CarPhoto({car,className="car-photo"}:{car:Car;className?:string}) {
  const [failed,setFailed]=useState(false);
  useEffect(()=>{setFailed(false);},[car.image_url]);
  const safe = typeof car.image_url === "string" && /^\/cars\/images\/[a-zA-Z0-9_.-]+$/.test(car.image_url);
  return <div className={`${className} unified-photo`}>
    {safe&&!failed?<img src={car.image_url!} alt={`Фото ${carName(car)}`} loading="eager" decoding="async" onError={()=>setFailed(true)}/>:
      <div className="car-fallback"><Icon name="car"/><span>Фото пока нет</span></div>}
  </div>;
}
export function Specs({car,keys,className}:{car:Car;keys:string[];className:string}) {
  const pairs=keys.map(key=>[fields[key],formatSpec(car,key)]).filter(pair=>pair[1]);
  return pairs.length>0?<dl className={className}>{pairs.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>:null;
}
export function TextSection({title,items}:{title:string;items?:string[]}) {
  return items?.length?<section className="dialog-section"><h3>{title}</h3><ul>{items.map((value,i)=><li key={i}>{value}</li>)}</ul></section>:null;
}
/** Общее модальное окно: сохраняем анимацию, Escape и закрытие по фону из оригинального сайта. */
export function Modal({title,onClose,children,className=""}:{title:string;onClose:()=>void;children:ReactNode;className?:string}) {
  const ref=useRef<HTMLDialogElement>(null);
  const opener=useRef<Element|null>(null); // Кнопка, которой пользователь открыл окно.
  const outsidePressed=useRef(false);       // Защита от закрытия при перетаскивании изнутри наружу.

  useEffect(()=>{
    const dialog=ref.current;
    if(!dialog)return;
    opener.current=document.activeElement;
    dialog.showModal();
    return ()=>{
      if(dialog.open)dialog.close();
      if(opener.current instanceof HTMLElement)opener.current.focus({preventScroll:true});
    };
  },[]);

  /** Сначала проигрываем короткую CSS-анимацию закрытия, затем размонтируем окно. */
  async function closeDialog(){
    const dialog=ref.current;
    if(!dialog||!dialog.open||dialog.classList.contains("closing"))return;
    dialog.classList.add("closing");
    await Promise.allSettled(dialog.getAnimations().map(animation=>animation.finished));
    onClose();
  }

  function isBackdropClick(event:{target:EventTarget|null;clientX:number;clientY:number}){
    const dialog=ref.current;
    if(!dialog||event.target!==dialog)return false;
    const bounds=dialog.getBoundingClientRect();
    return event.clientX<bounds.left||event.clientX>=bounds.right||event.clientY<bounds.top||event.clientY>=bounds.bottom;
  }

  return <dialog ref={ref} className={`dialog ${className}`} aria-label={title}
    onCancel={event=>{event.preventDefault();void closeDialog();}}
    onPointerDown={event=>{outsidePressed.current=isBackdropClick(event);}}
    onClick={event=>{if(outsidePressed.current&&isBackdropClick(event))void closeDialog();outsidePressed.current=false;}}>
    <div className="dialog-scroll-surface"><div className="dialog-heading">{title==="Об автомобиле"?<span>{title}</span>:<h2>{title}</h2>}
      <button type="button" className="icon-button" aria-label="Закрыть" onClick={()=>void closeDialog()}><Icon name="close"/></button>
    </div>{children}</div>
  </dialog>;
}
export function CarDetails({car,explanation,ranked=true}:{car:Car;explanation?:Explanation|null;ranked?:boolean}) {
  const keys=Object.keys(fields).filter(k=>![...scoreKeys,"price_rub"].includes(k));
  const statuses:Record<string,string>={matched:"Выполнено",rejected:"Не выполнено",unknown:"Нет данных"};
  let source: ReactNode=null;
  if(car.source){try{const url=new URL(car.source);if(["https:","http:"].includes(url.protocol))source=<a href={url.href} target="_blank" rel="noopener noreferrer">Источник характеристик</a>;}catch{source=String(car.source);}}
  return <div className="car-detail-react">
    {explanation&&<section className="dialog-section"><h3>Почему такой результат</h3><p>{explanation.message}</p><section className="dialog-conditions"><h4>Обязательные условия</h4>
      {explanation.conditions?.map((condition,index)=><div className="condition-row" key={index}>
        <span className={`condition-mark condition-${condition.status}`} aria-hidden="true">{condition.status==="matched"?"✓":condition.status==="rejected"?"×":"?"}</span>
        <span>{statuses[condition.status]||condition.status} — {condition.label}</span>
      </div>)}</section></section>}
    <div className="dialog-overview"><CarPhoto car={car} className="dialog-car-photo"/><div className="dialog-car-info"><h3>{carName(car)}</h3><p className="car-price">Ориентир · {priceText(car.price_rub)}</p><Specs car={car} keys={keys} className="dialog-specs"/></div></div>
    {ranked&&<dl className="dialog-score-grid">{scoreKeys.map(key=><div key={key}><dt>{fields[key]}</dt><dd>{formatSpec(car,key)||(car.profile_answer_count===0&&scoreKeys.includes(key)?"Мало ответов":"Нет данных")}</dd></div>)}</dl>}
    {car.rating_provenance?.safety==="estimated"&&<section className="dialog-section" aria-label="О достоверности оценок">
      <h3>Безопасность и надёжность</h3>
      <p>Баллы приблизительные, не официальные испытания.</p>
      <details className="rating-basis-details"><summary>Как оценивали</summary><p>{car.rating_provenance.basis}</p></details>
    </section>}
    <TextSection title="Почему эта машина тебе подходит" items={car.reasons}/><TextSection title="Что стоит учитывать" items={car.tradeoffs}/>
    <section className="dialog-section"><h3>Данные каталога</h3>{source&&<p>{source}</p>}{car.description&&!/демонстрационн|пользовательские оценки перенесены/i.test(car.description)&&<p>{car.description}</p>}{(car.data_date||car.verified_at)&&<p>Дата записи в каталоге · {car.data_date||car.verified_at}</p>}</section>
  </div>;
}

// ───────────── ГОТОВЫЕ ЭКРАНЫ И ИНТЕРАКТИВНЫЕ КАРТОЧКИ ─────────────
// Компоненты не обращаются к API: получают данные и обработчики из App.tsx.
// Реальные фотографии интерьеров двух автомобилей из каталога (CC0 и CC BY-SA 4.0).
// При отсутствии доступа к Wikimedia используется локальная резервная картинка.
const realInteriors:Record<string,string>={
  a:"https://thumb.wikimedia.org/wikipedia/commons/thumb/e/e3/2019_Peugeot_Traveller_Business_BlueHDi_2.0_Interior.jpg/960px-2019_Peugeot_Traveller_Business_BlueHDi_2.0_Interior.jpg",
  b:"https://thumb.wikimedia.org/wikipedia/commons/thumb/4/4b/Hyundai_IONIQ5_interior_in_Japan.jpg/1280px-Hyundai_IONIQ5_interior_in_Japan.jpg"
};
const duelImages=(number:number,choice:string)=>number===13&&realInteriors[choice]?realInteriors[choice]:`/static/images/duels/q${number}-${choice}.webp`;
const numberFormat=new Intl.NumberFormat("ru-RU",{maximumFractionDigits:0});

export function valuesOf(v:Answers[string]|undefined):string[]{return Array.isArray(v)?v:v===undefined?[]:[String(v)];}
export function cloneAnswers(value:Answers):Answers {return structuredClone(value);}
export function removeStaleExtras(draft:Answers):Answers {
  const result={...draft};
  if(result["1"]!=="custom")delete result.budgetMax;
  if(result["5"]!=="six")delete result.minSeats;
  if(!valuesOf(result["7"]).includes("engine")){delete result.engine;delete result.hybrid;}
  else if(result.engine!=="hybrid")delete result.hybrid;
  return result;
}
export function titleOfAnswer(answer:Answers,position:number):string{
  const q=questions[position],chosen=valuesOf(answer[String(position+1)]);
  const opts=position>=10?[...q.options,...duelExtras]:q.options;
  const parts=opts.filter(o=>chosen.includes(o[0])).map(o=>o[1]);
  if(position===0&&answer["1"]==="custom")return `${numberFormat.format(Number(answer.budgetMax||0))} ₽`;
  if(position===4&&answer["5"]==="six")return `Минимум мест — ${answer.minSeats||6}`;
  if(position===6&&chosen.includes("engine")){
    const f=fuels.find(o=>o[0]===answer.engine)?.[1],h=hybrids.find(o=>o[0]===answer.hybrid)?.[1];
    if(f)parts[parts.length-1]=[f,h].filter(Boolean).join(" · ");
  }
  return parts.join(", ")||"Пропущен";
}

// ───────────── БЛОК 1. Переиспользуемые элементы ─────────────
export function StartButton({children,onStart,loading=false,className="button button-primary"}:{children:ReactNode;onStart:()=>void;loading?:boolean;className?:string}){
  return <button type="button" className={`${className} ${loading?"starting":""}`} data-action="start" onClick={onStart} disabled={loading}>
    <span data-start-label>{children}</span>{loading?<svg className="start-car" viewBox="0 0 100 40" aria-hidden="true"><path fill="white" d="M5 25L12 17H25L38 5H65L80 17H90L96 25V32H5Z"/><circle cx="25" cy="32" r="7" fill="white"/><circle cx="76" cy="32" r="7" fill="white"/></svg>:<Icon name="arrow-right"/>}
  </button>;
}
/** Пример на главной открывает тот же диалог автомобиля, что и рекомендация. */
function PickCard({pick,onDetail}:{pick:HomePick;onDetail:(car:Car)=>void}){
  // Backend передаёт фотографию готового варианта отдельно от характеристик машины.
  // Передаём единый объект в карточку и «Подробнее», иначе в диалоге пропадает фото.
  const car:Car = {...pick.car, image_url:pick.image_url};
  return <article className="scenario-card scenario-card-react" role="button" tabIndex={0} onClick={()=>onDetail(car)}
    onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();onDetail(car);}}}>
    <h3>{pick.title}</h3><CarPhoto car={car} className="scenario-photo"/>
    <div className="scenario-copy"><h4>{carName(pick.car)}</h4><p>{pick.reason}</p></div>
    {pick.facts?.length>0&&<dl className="scenario-facts">{pick.facts.map(([label,value,unit])=><div key={label}><dt>{label}</dt><dd>{typeof value==="number"?numberFormat.format(value):value}{unit&&<> <small>{unit}</small></>}</dd></div>)}</dl>}
  </article>;
}
/** Главная страница: три готовые машины и запуск опроса. */
export function Home({picks,onStart,onDetail,starting,startLabel}:{picks:HomePick[];onStart:()=>void;onDetail:(car:Car)=>void;starting:boolean;startLabel:string}){
  return <div id="home">
    <section className="shell hero" aria-labelledby="hero-title"><div className="hero-copy">
      <h1 id="hero-title">Какая машина <span>тебе подходит?</span></h1>
      <p>Пройди короткий тест и найди автомобиль под свои задачи и стиль.</p>
      <div className="hero-actions"><StartButton onStart={onStart} loading={starting}>{startLabel}</StartButton><span className="hero-time"><Icon name="clock"/>2–4 минуты</span></div>
    </div><div className="hero-media"><img src="/static/images/hero.webp" alt="Синий кроссовер на фоне бетонных стен" width="1250" height="938"/></div></section>
    <section id="catalog" className="scenarios"><div className="shell"><h2>Готовые варианты</h2>
      <div className="scenario-grid">{picks.map(p=><PickCard key={p.car.id} pick={p} onDetail={onDetail}/>)}</div>
    </div></section>
    <section id="how" className="shell how"><h2>Как это работает</h2><ol className="steps">
      <li><span className="step-number">1</span><div><h3>Отвечаешь на вопросы</h3><p>Расскажи, как ты будешь использовать машину. Любой вопрос можно пропустить.</p></div></li>
      <li><span className="step-number">2</span><div><h3>Сравниваешь автомобили и интерьеры</h3><p>В пяти визуальных дуэлях выбирай то, что нравится.</p></div></li>
      <li><span className="step-number">3</span><div><h3>Получаешь рекомендации</h3><p>Сравни модели и узнай, почему каждая вошла в подбор.</p></div></li>
    </ol></section>
    <section className="shell bottom-section"><div className="bottom-cta"><h2>Готов найти свой автомобиль?</h2><StartButton onStart={onStart} loading={starting} className="button button-white">{startLabel}</StartButton></div></section>
    <footer className="site-footer"><div className="shell footer-inner">
      <a className="brand" href="#home" aria-label="AutoChoice, наверх"><img src="/static/images/mark.svg" alt="" width="32" height="32"/><span>Auto<span>Choice</span></span></a>
      <span>Игровой подбор автомобиля</span>
    </div></footer>
  </div>;
}

// ───────────── БЛОК 2. Опрос: вся бизнес-логика ответов хранится в React state ─────────────
/** Опрос использует единый интерфейс для десяти рациональных и пяти слепых вопросов. */
export function Quiz({index,draft,onChange,onNext,onBack,onSkip,error,editing,duels,duelsLoading,duelCacheReady}:{
  index:number;draft:Answers;onChange:(value:Answers)=>void;onNext:()=>void;onBack:()=>void;onSkip:()=>void;
  error:string;editing:boolean;duels:Record<string,Record<string,string>>;duelsLoading:boolean;duelCacheReady:boolean;
}){
  const q=questions[index],key=String(index+1),selected=valuesOf(draft[key]),visual=index>=10;
  // Визуальные дуэли должны быть слепыми: раскрывать стилевые теги нельзя.
  const hint=visual?"Выбери фото A или Б. Можно выбрать оба или ни один.":q.limit?"Можно выбрать до двух вариантов":q.multi?"Можно выбрать несколько вариантов":"Выбери один вариант";
  function choose(choice:string,group="main"){
    const next=cloneAnswers(draft);
    if(group==="engine"||group==="hybrid"){
      next[group]=choice;if(group==="engine")delete next.hybrid;
    }else if(group==="duel"||!q.multi){next[key]=choice;}
    else{if(selected.includes(choice))next[key]=selected.filter(v=>v!==choice);
      else if(!q.limit||selected.length<q.limit)next[key]=[...selected,choice];else return;}
    onChange(removeStaleExtras(next));
  }
  function optionCard(option:Option,order:number,group="main"){
    const [value,label,description]=option;
    const active=group==="engine"||group==="hybrid"?draft[group]===value:visual&&group==="main"?selected.includes(value):selected.includes(value);
    const src=group==="main"&&visual?(index===12?duelImages(13,value):(duels[key]?.[value]||duelImages(index+1,value))):
      `/static/images/questions/${group==="engine"||group==="hybrid" ? (option[2]||value):`q${index+1}-${order+1}`}.webp`;
    if(group==="duel")return <button key={value} type="button" className={`duel-choice ${active?"is-selected":""}`} aria-pressed={active} onClick={()=>choose(value,group)}>
      <span aria-hidden="true" className="duel-choice-icon">{value==="both"?"♥":"×"}</span><span>{label}</span>
    </button>;
    return <button key={value} type="button" className={`option-card ${active?"is-selected":""}`} aria-pressed={active} onClick={()=>choose(value,group)}>
      <img className="option-art" src={src} alt="" decoding="async" onError={e=>{const img=e.currentTarget;const fallback=`/static/images/duels/q${index+1}-${value}.webp`;
        if(visual&&!img.src.endsWith(fallback))img.src=fallback;else img.style.visibility="hidden";}}/>
      {visual?<span className="option-caption"><span className="option-letter">{value.toUpperCase()}</span><span className="option-copy"><span className="option-name">Вариант {value.toUpperCase()}</span></span></span>
        :<span className="option-copy"><span className="option-name">{label}</span>{description&&group==="main"&&<span className="option-description">{description}</span>}</span>}
      <span className="option-check"><Icon name="check"/></span>
    </button>;
  }
  function optionGroup(group:string,title:string,options:Option[]){return <div className="extra-group"><p className="extra-title">{title}</p><div className="extra-options">{options.map((o,i)=>optionCard(o,i,group))}</div></div>;}
  const currentEngine=selected.includes("engine")&&draft.engine;
  return <section className="shell quiz-screen" id="quiz"><div className="quiz-panel">
    <div className="quiz-navigation"><button type="button" className="button button-quiet" onClick={onBack}><Icon name="arrow-left"/>{editing?"К результатам":"Назад"}</button></div>
    <div className="quiz-progress-meta"><span>{visual?"Визуальные дуэли":"Твои потребности"}</span><span>Вопрос {index+1} из {questions.length}</span></div>
    <progress id="quiz-progress" max={questions.length} value={index+1} aria-label="Прогресс опроса"/>
    <div className="question" key={index}><h2 id="quiz-title" className="question-enter" tabIndex={-1}>{visual?"Какой дизайн тебе больше нравится?":q.title}</h2><p className="quiz-hint" id="quiz-hint">{hint}</p>
      {visual&&(duelsLoading||!duelCacheReady)?<div className="duel-loading" role="status">Подбираем фотографии под твои ответы…</div>:
      <div className={`quiz-options question-enter ${visual?"is-duel":""}`}>{q.options.map((o,i)=>optionCard(o,i))}
        {visual&&<div className="duel-actions">{duelExtras.map((o,i)=>optionCard(o,i,"duel"))}</div>}
      </div>}
      <div id="quiz-extra">
        {index===0&&selected.includes("custom")&&<label className="extra-field"><span className="extra-title">Максимальная цена в рублях</span><input type="number" className="extra-input" min="1" value={draft.budgetMax??""} placeholder="Например, 3500000" onChange={e=>onChange({...draft,budgetMax:e.target.value})}/></label>}
        {index===4&&selected.includes("six")&&<label className="extra-field"><span className="extra-title">Минимальное количество мест (от 6 до 99)</span><input type="number" className="extra-input" min="6" max="99" value={draft.minSeats??6} onChange={e=>onChange({...draft,minSeats:e.target.value})}/></label>}
        {index===6&&selected.includes("engine")&&optionGroup("engine","Какой двигатель тебе нужен?",fuels)}
        {index===6&&currentEngine==="hybrid"&&optionGroup("hybrid","Какой тип гибрида тебе подходит?",hybrids)}
      </div>
      {error&&<p className="form-error" role="alert">{error}</p>}
    </div>
    <div className="quiz-submit"><button type="button" className="button button-primary" onClick={onNext}>{editing?"Сохранить и пересчитать":index===14?"Получить рекомендации":"Продолжить"}<Icon name="arrow-right"/></button>
      <button type="button" className="button button-secondary skip-button" onClick={onSkip}>Пропустить</button></div>
  </div></section>;
}

// ───────────── БЛОК 3. Карточки результатов и сравнение ─────────────
const pickLabels:Record<string,[string,string]>={reason:["Разумный выбор","gauge"],heart:["Выбор сердцем","heart"],balance:["Твой баланс","layers"]};
function pickExplanation(car:Car,type:string):string {
  const reasons=car.reasons||[];
  const practical=reasons.find(r=>r.startsWith("Сильная сторона"));
  const visual=reasons.find(r=>r.startsWith("Соответствует визуальному выбору"));
  if(car.profile_answer_count===0)return "Ответь на вопросы, чтобы получить предварительный рейтинг.";
  if(type==="reason")return practical||"Вошёл в подбор по практическим характеристикам.";
  if(type==="heart")return visual||"Вошёл в подбор по твоим предпочтениям во внешности и салоне.";
  if(car.total==null)return reasons[0]||"Для объяснения пока мало данных.";
  if(car.heart==null)return "Учли практичность. Для оценки стиля пока мало данных.";
  if(car.reason==null)return "Учли твой выбор дизайна. Для оценки практичности пока мало данных.";
  return [practical,visual].filter(Boolean).join(" ")||"Вошёл в подбор по сочетанию практичности и стиля.";
}
/** Кликабельная карточка: сравнение не открывает модалку подробностей. */
export function ResultCard({car,type,selected,onDetail,onCompare}:{car:Car;type:string;selected:boolean;onDetail:()=>void;onCompare:()=>void}){
  const [label,glyph]=car.total_adjusted==null?["По заданным условиям","check"]:pickLabels[type]||pickLabels.balance;
  function keyboard(e:KeyboardEvent<HTMLElement>){if(e.target===e.currentTarget&&(e.key==="Enter"||e.key===" ")){e.preventDefault();onDetail();}}
  return <article className={`car-card ${selected?"selected-car":""}`} tabIndex={0} role="button" aria-label={`Подробнее о ${carName(car)}`} onKeyDown={keyboard} onClick={onDetail}>
    <div className="car-main"><CarPhoto car={car}/><div className="car-info">
      <div className="car-head"><h3>{carName(car)}</h3><p>{[car.trim,car.year].filter(Boolean).join(" · ")}</p></div>
      <p className="car-price">Ориентир · {priceText(car.price_rub)}</p>
      <Specs car={car} keys={["body_type","seats","transmission","drive","fuel_type"]} className="car-specs"/>
      <p className="car-rating">{car.total_adjusted==null?"Подходит под заданные условия":(car.profile_answer_count??0)<7?"Предварительная совместимость":"Совместимость"} · {formatSpec(car,"total")||"Личных данных пока мало"}</p>
      <button className={`car-link compare-toggle ${selected?"is-compared":""}`} type="button" aria-pressed={selected}
        onClick={e=>{e.stopPropagation();onCompare();}}>{selected?"Убрать из сравнения":"Сравнить"}</button>
    </div></div>
    <footer className="car-pick"><strong className="car-pick-label" data-pick={type}><Icon name={glyph}/>{label}</strong>
      <p>{car.total_adjusted==null?"Обязательные условия выполнены; для персонального рейтинга добавь предпочтения.":pickExplanation(car,type)}</p></footer>
  </article>;
}
/** Таблица сравнения двух или трёх моделей из готового каталога. */
export function CompareContent({cars,onRemove}:{cars:Car[];onRemove:(id:string)=>void}){
  const style={"--compare-count":cars.length} as CSSProperties;
  return <div className="compare-root" style={style}>
    <p className="compare-swipe-hint">Листай таблицу вправо и влево, чтобы увидеть все автомобили.</p>
    <div className="compare-grid">{cars.map(c=><div key={c.id} className="compare-car"><CarPhoto car={c} className="dialog-car-photo"/><h3>{carName(c)}</h3><p>{c.trim||"Нет данных"}</p><button className="car-link" onClick={()=>onRemove(c.id)}>Убрать из сравнения</button></div>)}</div>
    <div className="compare-specs">{specificationKeys.map(key=>{
      const values=cars.map(c=>formatSpec(c,key));
      const numbers=cars.map(c=>key==="total"?c.total_adjusted:key==="completeness"?c.data_coverage:c[key]);
      const different=values.every(Boolean)&&new Set(values).size>1;
      let best:number|null=null;
      if(different&&numbers.every(n=>typeof n==="number"&&Number.isFinite(n))){
        const numeric=numbers as number[];
        if(["price_rub","fuel_consumption"].includes(key))best=Math.min(...numeric);
        if(["seats","boot_l","clearance_mm","engine_power_hp",...scoreKeys].includes(key))best=Math.max(...numeric);
      }
      return <div className={`compare-row${different?" differs":""}`} key={key}><span>{fields[key]}</span>{cars.map((c,i)=><strong key={c.id} className={best!==null&&numbers[i]===best?"compare-best":""}>{values[i]||"Нет данных"}</strong>)}</div>;
    })}</div>
    <div className="compare-notes">{cars.map(c=><div key={c.id}><h4>{carName(c)}</h4><TextSection title="Преимущества" items={c.reasons}/><TextSection title="Что стоит учитывать" items={c.tradeoffs}/></div>)}</div>
  </div>;
}

