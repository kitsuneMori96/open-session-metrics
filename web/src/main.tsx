import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import "./index.css";
import App from "./App";
import { Boundary } from "./components/Boundary";

/**
 * The store only moves when the server re-materializes it, so a focused tab revalidates
 * rather than polls aggressively; the panels that do poll keep their previous frame while
 * a new slice settles.
 */
const client = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15000, refetchOnWindowFocus: true, retry: 1 },
  },
});

createRoot(document.getElementById("root")!).render(
  <Boundary>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </Boundary>
);
