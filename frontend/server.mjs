/**
 * Минимальный HTTP-сервер React: только статические файлы из dist.
 * Вся бизнес-логика находится в Flask; сюда нет API и базы данных.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";
const root=resolve(fileURLToPath(new URL("./dist/", import.meta.url)));             // Каталог результата сборки React.
const port=Number(process.env.PORT||3000);   // Внутренний порт frontend-контейнера.
const mime={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".svg":"image/svg+xml",".webp":"image/webp",".jpg":"image/jpeg",".jpeg":"image/jpeg",".png":"image/png",".ico":"image/x-icon",".json":"application/json; charset=utf-8"};
createServer(async(req,res)=>{
  if(req.method!=="GET"&&req.method!=="HEAD"){res.writeHead(405).end();return;}
  let pathname;
  try{pathname=decodeURIComponent(new URL(req.url||"/","http://localhost").pathname);}catch{res.writeHead(400).end();return;}
  const file=resolve(root,"."+pathname);
  if(file!==root&&!file.startsWith(root+sep)){res.writeHead(403).end();return;}
  try{
    // Для неизвестного URL React-приложение получает index.html (SPA fallback).
    const existing=await stat(file).catch(()=>null);
    const target=existing?.isFile()?file:resolve(root,"index.html");
    // Несуществующие изображения или ассеты не должны возвращать HTML.
    if(!existing&&extname(pathname)){res.writeHead(404).end();return;}
    const content=await readFile(target);
    res.writeHead(200,{"Content-Type":mime[extname(target)]||"application/octet-stream","Cache-Control":target.endsWith("index.html")?"no-store":"public, max-age=86400"});
    if(req.method==="HEAD")res.end();else res.end(content);
  }catch{res.writeHead(404).end();}
}).listen(port,"0.0.0.0",()=>console.log(`React frontend listening on ${port}`));
