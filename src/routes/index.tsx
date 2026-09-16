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
          "New Solana memecoin launches detected on-chain within seconds, with live buy/sell volume.",
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
  buy_count: number;
  sell_count: number;
  volume_sol: number;
  price_sol: number | null;
  market_cap_sol: number | null;
  last_trade_at: string | null;
};

type TradeRow = {
  id: string;
  mint: string;
  is_buy: boolean;
  sol_amount: number;
  token_amount: number;
  user_wallet: string | null;
  trade_time: string;
};

function shortAddress(value: string | null) {
  if (!value) return "—";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function formatSol(value: number | null | undefined) {
  if (value == null) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.001) return value.toFixed(4);
  return value.toExponential(1);
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

function PressureBar({ buys, sells }: { buys: number; sells: number }) {
  const total = buys + sells;
  const buyPct = total === 0 ? 50 : Math.round((buys / total) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-destructive/40">
        <div className="h-full bg-primary" style={{ width: `${buyPct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">
        <span className="text-primary">{buys}</span>/<span className="text-destructive">{sells}</span>
      </span>
    </div>
  );
}

type SortMode = "age" | "volume";

function Radar() {
  const queryClient = useQueryClient();
  const poll = useServerFn(pollPumpTokens);
  const now = useNow();
  const [listener, setListener] = useState<{ ok: boolean; error?: string } | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("age");
  const [selectedMint, setSelectedMint] = useState<string | null>(null);

  const tokensQuery = useQuery({
    queryKey: ["pump_tokens"],
    queryFn: async (): Promise<TokenRow[]> => {
      const { data, error } = await supabase
        .from("pump_tokens")
        .select(
          "id, mint, name, symbol, creator, signature, block_time, detected_at, buy_count, sell_count, volume_sol, price_sol, market_cap_sol, last_trade_at",
        )
        .order("block_time", { ascending: false, nullsFirst: false })
        .limit(60);
      if (error) throw error;
      return (data ?? []) as TokenRow[];
    },
    refetchInterval: 4000,
  });

  const tradesQuery = useQuery({
    queryKey: ["pump_trades", selectedMint],
    enabled: selectedMint !== null,
    queryFn: async (): Promise<TradeRow[]> => {
      const { data, error } = await supabase
        .from("pump_trades")
        .select("id, mint, is_buy, sol_amount, token_amount, user_wallet, trade_time")
        .eq("mint", selectedMint!)
        .order("trade_time", { ascending: false })
        .limit(25);
      if (error) throw error;
      return (data ?? []) as TradeRow[];
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
        if (result.inserted > 0 || (result.trades ?? 0) > 0) {
          queryClient.invalidateQueries({ queryKey: ["pump_tokens"] });
          queryClient.invalidateQueries({ queryKey: ["pump_trades"] });
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

  const tokens = [...(tokensQuery.data ?? [])];
  if (sortMode === "volume") {
    tokens.sort((a, b) => (b.volume_sol ?? 0) - (a.volume_sol ?? 0));
  }
  const lastMinute = tokens.filter(
    (t) => now - new Date(t.block_time ?? t.detected_at).getTime() < 60_000,
  ).length;
  const totalVolume = tokens.reduce((sum, t) => sum + (t.volume_sol ?? 0), 0);

  const statusLabel =
    listener === null
      ? "CONNECTING"
      : listener.ok
        ? "LIVE"
        : listener.error === "missing_rpc_key"
          ? "NO RPC KEY"
          : "RPC ERROR";

  const selectedToken = tokens.find((t) => t.mint === selectedMint) ?? null;

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 py-10 sm:px-8">
      <header className="flex flex-wrap items-end justify-between gap-6 border-b border-border pb-6">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">
            Phase 2 · On-chain detection + live volume
          </p>
          <h1 className="mt-2 text-3xl font-bold text-foreground sm:text-4xl">
            Solana Memecoin Radar
          </h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            New Pump.fun launches and every buy/sell read straight from the Solana chain over
            RPC. No website scraping, no trading — detect, store, display.
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
        <Stat label="Volume (list)" value={`${formatSol(totalVolume)} SOL`} />
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
          <div className="flex items-center gap-2 text-xs">
            <button
              className={sortMode === "age" ? "sort-btn sort-btn-active" : "sort-btn"}
              onClick={() => setSortMode("age")}
            >
              By age
            </button>
            <button
              className={sortMode === "volume" ? "sort-btn sort-btn-active" : "sort-btn"}
              onClick={() => setSortMode("volume")}
            >
              By volume
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 font-medium">Symbol</th>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Age</th>
                <th className="px-4 py-3 text-right font-medium">MCap (SOL)</th>
                <th className="px-4 py-3 text-right font-medium">Volume (SOL)</th>
                <th className="px-4 py-3 font-medium">Buy/Sell</th>
                <th className="px-4 py-3 font-medium">Mint</th>
                <th className="px-4 py-3 text-right font-medium">Tx</th>
              </tr>
            </thead>
            <tbody>
              {tokens.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">
                    {tokensQuery.isLoading
                      ? "Loading…"
                      : "Waiting for the next on-chain launch…"}
                  </td>
                </tr>
              )}
              {tokens.map((token) => (
                <tr
                  key={token.id}
                  onClick={() =>
                    setSelectedMint(selectedMint === token.mint ? null : token.mint)
                  }
                  className={`row-in cursor-pointer border-t border-border/60 hover:bg-secondary/40 ${
                    selectedMint === token.mint ? "bg-secondary/50" : ""
                  }`}
                >
                  <td className="px-4 py-3 font-bold text-primary">{token.symbol || "—"}</td>
                  <td className="max-w-[200px] truncate px-4 py-3 text-foreground">
                    {token.name || "Unknown"}
                  </td>
                  <td className="px-4 py-3 text-accent">
                    {formatAge(token.block_time ?? token.detected_at, now)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-foreground">
                    {formatSol(token.market_cap_sol)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-foreground">
                    {formatSol(token.volume_sol)}
                  </td>
                  <td className="px-4 py-3">
                    <PressureBar buys={token.buy_count} sells={token.sell_count} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <a
                      className="hover:text-foreground"
                      href={`https://solscan.io/token/${token.mint}`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {shortAddress(token.mint)}
                    </a>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {token.signature ? (
                      <a
                        className="text-accent hover:underline"
                        href={`https://solscan.io/tx/${token.signature}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
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

      {selectedToken && (
        <section className="panel mt-6 overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-sm font-bold uppercase tracking-[0.2em] text-foreground">
              Live trades · {selectedToken.symbol || shortAddress(selectedToken.mint)}
            </h2>
            <button
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setSelectedMint(null)}
            >
              close ✕
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Time</th>
                  <th className="px-4 py-3 font-medium">Side</th>
                  <th className="px-4 py-3 text-right font-medium">SOL</th>
                  <th className="px-4 py-3 text-right font-medium">Tokens</th>
                  <th className="px-4 py-3 font-medium">Wallet</th>
                </tr>
              </thead>
              <tbody>
                {(tradesQuery.data ?? []).length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                      {tradesQuery.isLoading ? "Loading…" : "No trades recorded yet."}
                    </td>
                  </tr>
                )}
                {(tradesQuery.data ?? []).map((trade) => (
                  <tr key={trade.id} className="border-t border-border/60">
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {formatAge(trade.trade_time, now)} ago
                    </td>
                    <td
                      className={`px-4 py-2.5 font-bold ${
                        trade.is_buy ? "text-primary" : "text-destructive"
                      }`}
                    >
                      {trade.is_buy ? "BUY" : "SELL"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-foreground">
                      {formatSol(trade.sol_amount)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                      {formatSol(trade.token_amount)}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {shortAddress(trade.user_wallet)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <footer className="mt-6 text-xs text-muted-foreground">
        Next phases: wallet stats &amp; deterministic scoring → alerts → paper trading.
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
