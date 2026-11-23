import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
// Во время npm run dev запросы /api и /cars направляются в Python.
export default defineConfig({
  plugins:[react()],
  server:{host:"0.0.0.0",port:3000,proxy:{"/api":"http://localhost:8000","/cars":"http://localhost:8000","/health":"http://localhost:8000"}}
});
