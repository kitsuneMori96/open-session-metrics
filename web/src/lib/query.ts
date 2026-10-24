import { QueryClient } from "@tanstack/react-query";

/**
 * One cache per source scope.
 *
 * Switching a source is not a filter change: no key would be valid under the new
 * store, and adding a `src` dimension to every key would leave the old store's
 * pages in memory, one stray `keepPreviousData` away from drawing a session that
 * does not exist here. So a switch builds a new client and the old one is
 * garbage-collected with the components that were reading it.
 *
 * The store only moves when the server re-materializes it, so a focused tab
 * revalidates rather than polls aggressively; the panels that do poll keep their
 * previous frame while a new slice settles.
 */
export const makeClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { staleTime: 15000, refetchOnWindowFocus: true, retry: 1 },
    },
  });
