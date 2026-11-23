import { carName, formatSpec, type Car, type Results } from "./format";

// Всё содержимое публичной карточки строится из готового ответа Flask.
// Бюджет, ответы анкеты и другие частные сведения сюда намеренно не попадают.
const IMAGE_WIDTH = 1080;
const IMAGE_HEIGHT = 1350;

/** Закруглённый прямоугольник используется для карточек, плашек и диаграмм. */
function roundedBox(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string | CanvasGradient) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

/** Не обрезаем длинные названия: переводим строки и ставим многоточие. */
function drawWrapped(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, maxWidth: number, lineHeight: number, maxLines: number) {
  const words = value.trim().split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  lines.slice(0, maxLines).forEach((text, index) => {
    if (index === maxLines - 1 && lines.length > maxLines) {
      while (text.length && ctx.measureText(`${text}…`).width > maxWidth) text = text.slice(0, -1);
      text += "…";
    }
    ctx.fillText(text, x, y + index * lineHeight);
  });
}

/** Рисуем фото по центру: автомобиль виден полностью, без растяжения. */
async function drawCarPhoto(ctx: CanvasRenderingContext2D, car: Car) {
  if (!car.image_url?.startsWith("/cars/images/")) return;
  try {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.src = car.image_url;
    await image.decode();
    const maxWidth = 860;
    const maxHeight = 390;
    const scale = Math.min(maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    ctx.drawImage(image, (IMAGE_WIDTH - width) / 2, 281 + (maxHeight - height) / 2, width, height);
  } catch { /* Если фото недоступно, остальные элементы PNG сохраняются. */ }
}

/** Создаёт PNG 1080×1350 с наиболее совместимой машиной и профилем ДНК. */
export async function makeResultImage(data: Results): Promise<Blob> {
  if (data.status !== "matches" || !data.picks.length)
    throw new Error("Сначала получи рекомендации, чтобы сохранить результат.");
  const car: Car | undefined = [...data.picks]
    .sort((a, b) => (b.car.total_adjusted ?? -1) - (a.car.total_adjusted ?? -1))[0]?.car;
  if (!car) throw new Error("Не удалось определить рекомендованный автомобиль.");

  const canvas = document.createElement("canvas");
  canvas.width = IMAGE_WIDTH;
  canvas.height = IMAGE_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Браузер не поддерживает создание PNG.");

  // Фон и фирменная верхняя полоса.
  const backdrop = ctx.createLinearGradient(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);
  backdrop.addColorStop(0, "#f7fbff");
  backdrop.addColorStop(1, "#dceafb");
  ctx.fillStyle = backdrop;
  ctx.fillRect(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);
  roundedBox(ctx, 63, 57, 64, 64, 19, "#245de0");
  ctx.fillStyle = "white"; ctx.font = "800 37px Arial, sans-serif";
  ctx.fillText("A", 82, 103);
  ctx.fillStyle = "#17345d"; ctx.font = "800 43px Arial, sans-serif";
  ctx.fillText("AutoChoice", 145, 104);
  ctx.fillStyle = "#667f9e"; ctx.font = "500 23px Arial, sans-serif";
  ctx.fillText("МОЙ АВТОМОБИЛЬНЫЙ ПРОФИЛЬ", 66, 170);

  // Объёмная белая карточка с мягкой тенью.
  ctx.shadowColor = "rgba(25,64,122,.14)";
  ctx.shadowBlur = 34;
  ctx.shadowOffsetY = 16;
  roundedBox(ctx, 48, 211, 984, 1066, 34, "#ffffff");
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // Фото машины на спокойном градиенте — без жёсткой обрезки.
  const photoGradient = ctx.createLinearGradient(90, 250, 960, 675);
  photoGradient.addColorStop(0, "#e9f4ff");
  photoGradient.addColorStop(1, "#dbe9fa");
  roundedBox(ctx, 85, 250, 910, 420, 27, photoGradient);
  await drawCarPhoto(ctx, car);

  // Название и показатель персональной совместимости.
  ctx.fillStyle = "#456eab";
  ctx.font = "800 22px Arial, sans-serif";
  ctx.fillText(data.personalization?.answered && data.personalization.answered < (data.personalization.recommended || 7)
    ? "ПРЕДВАРИТЕЛЬНО НАИБОЛЕЕ СОВМЕСТИМ"
    : "НАИБОЛЕЕ СОВМЕСТИМ С ТВОИМИ ОТВЕТАМИ", 106, 717);
  ctx.fillStyle = "#142d54";
  ctx.font = "800 47px Arial, sans-serif";
  drawWrapped(ctx, carName(car), 106, 777, 870, 56, 2);

  roundedBox(ctx, 105, 868, 300, 68, 19, "#245de0");
  ctx.fillStyle = "#ffffff";
  ctx.font = "800 32px Arial, sans-serif";
  ctx.fillText(formatSpec(car, "total") || "Без оценки", 124, 912);
  ctx.fillStyle = "#4c6a94";
  ctx.font = "600 22px Arial, sans-serif";
  ctx.fillText("Совместимость по анкете", 426, 912);

  ctx.strokeStyle = "#e5edf7";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(105, 970);
  ctx.lineTo(973, 970);
  ctx.stroke();

  // Три основных приоритета в виде небольших понятных диаграмм.
  ctx.fillStyle = "#17345d";
  ctx.font = "800 27px Arial, sans-serif";
  ctx.fillText("ТВОЯ АВТОМОБИЛЬНАЯ ДНК", 106, 1016);
  const traits = [...data.dna.traits].filter(t => t.percent > 0)
    .sort((a, b) => b.percent - a.percent).slice(0, 3);
  traits.forEach((trait, index) => {
    const y = 1058 + index * 57;
    ctx.fillStyle = "#344d71";
    ctx.font = "600 23px Arial, sans-serif";
    ctx.fillText(trait.label, 106, y);
    roundedBox(ctx, 480, y - 20, 394, 18, 9, "#e6f0ff");
    roundedBox(ctx, 480, y - 20, 394 * trait.percent / 100, 18, 9, "#5c91f1");
    ctx.fillStyle = "#215bc3";
    ctx.font = "800 23px Arial, sans-serif";
    ctx.fillText(`${trait.percent}%`, 893, y);
  });
  if (!traits.length) {
    ctx.fillStyle = "#64748b"; ctx.font = "23px Arial, sans-serif";
    ctx.fillText("Для профиля вкусов пока мало ответов", 106, 1081);
  }

  // Нейтральный футер: не раскрываем бюджет и не обещаем точность прогноза.
  ctx.fillStyle = "#8091aa";
  ctx.font = "20px Arial, sans-serif";
  ctx.fillText("AutoChoice · результат основан на выбранных предпочтениях", 106, 1248);

  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Не удалось создать PNG.")), "image/png"));
}
