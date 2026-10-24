import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "./index.css";
import App from "./App";
import { Boundary } from "./components/Boundary";

/**
 * The query cache is owned by `App`, not by the root: it is scoped to a data
 * source, so switching one must be able to throw it away wholesale.
 */
createRoot(document.getElementById("root")!).render(
  <Boundary>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </Boundary>
);
