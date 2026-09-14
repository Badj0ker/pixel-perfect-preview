import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { pollPumpTokens } from "@/lib/radar.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Solana Memecoin Radar — Live Pump.fun Launch Detection" },
      {
        name: "description",
        content:
          "Real-time radar that detects new Pump.fun token launches straight from the Solana blockchain via RPC — no website scraping.",
      },
      { property: "og:title", content: "Solana Memecoin Radar — Live Launch Detection" },
      {
        property: "og:description",
        content:
          "New Solana memecoin launches detected on-chain within seconds. Phase 1: detect, store, display.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Radar,
});

type TokenRow = {
  id: string;
  mint: string;
  name: string | null;
  symbol: string | null;
  creator: string | null;
  signature: string | null;
  block_time: string | null;
  detected_at: string;
};

function shortAddress(value: string | null) {
  if (!value) return "—";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function formatAge(from: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function Radar() {
  const queryClient = useQueryClient();
  const poll = useServerFn(pollPumpTokens);
  const now = useNow();
  const [listener, setListener] = useState<{ ok: boolean; error?: string } | null>(null);

  const tokensQuery = useQuery({
    queryKey: ["pump_tokens"],
    queryFn: async (): Promise<TokenRow[]> => {
      const { data, error } = await supabase
        .from("pump_tokens")
        .select("id, mint, name, symbol, creator, signature, block_time, detected_at")
        .order("block_time", { ascending: false, nullsFirst: false })
        .limit(60);
      if (error) throw error;
      return (data ?? []) as TokenRow[];
    },
    refetchInterval: 4000,
  });

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const result = await poll({ data: undefined });
        if (cancelled) return;
        setListener(result);
        if (result.inserted > 0) {
          queryClient.invalidateQueries({ queryKey: ["pump_tokens"] });
        }
      } catch {
        if (!cancelled) setListener({ ok: false, error: "listener_unreachable" });
      }
    };
    run();
    const id = setInterval(run, 6000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [poll, queryClient]);

  const tokens = tokensQuery.data ?? [];
  const lastMinute = tokens.filter(
    (t) => now - new Date(t.block_time ?? t.detected_at).getTime() < 60_000,
  ).length;

  const statusLabel =
    listener === null
      ? "CONNECTING"
      : listener.ok
        ? "LIVE"
        : listener.error === "missing_rpc_key"
          ? "NO RPC KEY"
          : "RPC ERROR";

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 py-10 sm:px-8">
      <header className="flex flex-wrap items-end justify-between gap-6 border-b border-border pb-6">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">
            Phase 1 · On-chain detection
          </p>
          <h1 className="mt-2 text-3xl font-bold text-foreground sm:text-4xl">
            Solana Memecoin Radar
          </h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            New Pump.fun launches read straight from the Solana chain over RPC. No website
            scraping, no trading — detect, store, display.
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs">
          <span className={listener?.ok !== false ? "live-dot" : "live-dot opacity-40"} />
          <span
            className={
              listener?.ok === false ? "font-bold text-destructive" : "font-bold text-primary"
            }
          >
            {statusLabel}
          </span>
        </div>
      </header>

      <section className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Tokens tracked" value={tokens.length.toString()} />
        <Stat label="Last 60s" value={lastMinute.toString()} />
        <Stat label="Source" value="Pump.fun program" />
        <Stat label="Poll interval" value="6s" />
      </section>

      {listener?.ok === false && (
        <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Listener problem: {listener.error}
        </p>
      )}

      <section className="panel mt-6 overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-bold uppercase tracking-[0.2em] text-foreground">
            New tokens
          </h2>
          <span className="text-xs text-muted-foreground">auto-refresh</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 font-medium">Symbol</th>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Age</th>
                <th className="px-4 py-3 font-medium">Mint</th>
                <th className="px-4 py-3 font-medium">Creator</th>
                <th className="px-4 py-3 text-right font-medium">Tx</th>
              </tr>
            </thead>
            <tbody>
              {tokens.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                    {tokensQuery.isLoading
                      ? "Loading…"
                      : "Waiting for the next on-chain launch…"}
                  </td>
                </tr>
              )}
              {tokens.map((token) => (
                <tr
                  key={token.id}
                  className="row-in border-t border-border/60 hover:bg-secondary/40"
                >
                  <td className="px-4 py-3 font-bold text-primary">{token.symbol || "—"}</td>
                  <td className="max-w-[220px] truncate px-4 py-3 text-foreground">
                    {token.name || "Unknown"}
                  </td>
                  <td className="px-4 py-3 text-accent">
                    {formatAge(token.block_time ?? token.detected_at, now)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <a
                      className="hover:text-foreground"
                      href={`https://solscan.io/token/${token.mint}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {shortAddress(token.mint)}
                    </a>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {shortAddress(token.creator)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {token.signature ? (
                      <a
                        className="text-accent hover:underline"
                        href={`https://solscan.io/tx/${token.signature}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        view
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="mt-6 text-xs text-muted-foreground">
        Next phases: live buy/sell volume &amp; wallet stats → deterministic scoring → alerts →
        paper trading.
      </footer>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="panel px-4 py-3">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-bold text-foreground">{value}</p>
    </div>
  );
}
