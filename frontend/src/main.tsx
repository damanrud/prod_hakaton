import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Единственная точка входа: React управляет всей разметкой сайта.
createRoot(document.getElementById("root")!).render(<App/>);
