// Generalized version of useLivePosition.ts's own loading/ready/error state machine,
// parameterized over which fetch function to run -- same anti-staleness discipline (no variant
// can be populated from archived JSON), reused across all three new categories instead of
// copy-pasting the hook three times.

import { useCallback, useEffect, useState } from "react";

export type LiveAgentQuery<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; message: string };

export function useLiveAgentState<T>(fetchFn: () => Promise<T>) {
  const [query, setQuery] = useState<LiveAgentQuery<T>>({ status: "loading" });

  const refetch = useCallback(() => {
    setQuery({ status: "loading" });
    fetchFn()
      .then((data) => setQuery({ status: "ready", data }))
      .catch((err) => setQuery({ status: "error", message: err instanceof Error ? err.message : String(err) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { query, refetch };
}
