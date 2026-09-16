import { createServerFn } from "@tanstack/react-start";
import { base58Encode } from "./base58";

const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

type CreateEvent = {
  kind: "create";
  name: string;
  symbol: string;
  uri: string;
  mint: string;
  bondingCurve: string;
  creator: string;
};

type TradeEvent = {
  kind: "trade";
  mint: string;
  solAmount: number;
  tokenAmount: number;
  isBuy: boolean;
  user: string;
  timestamp: number;
  priceSol: number | null;
  marketCapSol: number | null;
};

// Anchor event discriminators emitted by the Pump.fun program.
const CREATE_DISC = [27, 114, 169, 77, 222, 235, 99, 118];
const TRADE_DISC = [189, 219, 127, 211, 78, 230, 97, 238];
const TOKEN_SUPPLY = 1_000_000_000;

function hasDisc(data: Uint8Array, disc: number[]): boolean {
  if (data.length < 8) return false;
  for (let i = 0; i < 8; i++) if (data[i] !== disc[i]) return false;
  return true;
}

function decodeBase64(input: string): Uint8Array {
  const binary = atob(input);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function makeReader(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decoder = new TextDecoder();
  let offset = 8; // anchor event discriminator
  return {
    string(): string {
      const len = view.getUint32(offset, true);
      offset += 4;
      if (len > 200 || offset + len > data.length) throw new Error("bad string");
      const value = decoder.decode(data.subarray(offset, offset + len));
      offset += len;
      return value;
    },
    pubkey(): string {
      if (offset + 32 > data.length) throw new Error("bad pubkey");
      const value = base58Encode(data.subarray(offset, offset + 32));
      offset += 32;
      return value;
    },
    u64(): number {
      if (offset + 8 > data.length) throw new Error("bad u64");
      const value = view.getBigUint64(offset, true);
      offset += 8;
      return Number(value);
    },
    i64(): number {
      if (offset + 8 > data.length) throw new Error("bad i64");
      const value = view.getBigInt64(offset, true);
      offset += 8;
      return Number(value);
    },
    bool(): boolean {
      if (offset + 1 > data.length) throw new Error("bad bool");
      const value = data[offset] === 1;
      offset += 1;
      return value;
    },
  };
}

/** Decodes a Pump.fun anchor CreateEvent emitted as a `Program data:` log line. */
function parseCreateEvent(data: Uint8Array): CreateEvent | null {
  if (!hasDisc(data, CREATE_DISC)) return null;
  try {
    const r = makeReader(data);
    const name = r.string();
    const symbol = r.string();
    const uri = r.string();
    const mint = r.pubkey();
    const bondingCurve = r.pubkey();
    const creator = r.pubkey();
    if (!uri.startsWith("http") && !uri.startsWith("ipfs")) return null;
    return { kind: "create", name, symbol, uri, mint, bondingCurve, creator };
  } catch {
    return null;
  }
}

/** Decodes a Pump.fun anchor TradeEvent (every buy and sell on the bonding curve). */
function parseTradeEvent(data: Uint8Array): TradeEvent | null {
  if (!hasDisc(data, TRADE_DISC)) return null;
  try {
    const r = makeReader(data);
    const mint = r.pubkey();
    const solAmountRaw = r.u64();
    const tokenAmountRaw = r.u64();
    const isBuy = r.bool();
    const user = r.pubkey();
    const timestamp = r.i64();

    let priceSol: number | null = null;
    let marketCapSol: number | null = null;
    try {
      const virtualSolReserves = r.u64() / 1e9;
      const virtualTokenReserves = r.u64() / 1e6;
      if (virtualTokenReserves > 0) {
        priceSol = virtualSolReserves / virtualTokenReserves;
        marketCapSol = priceSol * TOKEN_SUPPLY;
      }
    } catch {
      // older event layout without reserves — price stays unknown
    }

    return {
      kind: "trade",
      mint,
      solAmount: solAmountRaw / 1e9,
      tokenAmount: tokenAmountRaw / 1e6,
      isBuy,
      user,
      timestamp,
      priceSol,
      marketCapSol,
    };
  } catch {
    return null;
  }
}


async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} failed: ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result as T;
}

/**
 * Polls the Solana chain directly (via Helius RPC) for fresh Pump.fun token
 * creations and stores any new ones. No website scraping involved.
 */
export const pollPumpTokens = createServerFn({ method: "POST" }).handler(async () => {
  const apiKey = process.env["HELIUS_API_KEY"];
  if (!apiKey)
    return { ok: false, error: "missing_rpc_key", inserted: 0, scanned: 0, trades: 0 };

  const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  let scanned = 0;
  let inserted = 0;
  let tradesInserted = 0;

  try {
    const signatures = await rpc<Array<{ signature: string; err: unknown }>>(
      url,
      "getSignaturesForAddress",
      [PUMP_PROGRAM, { limit: 40 }],
    );
    const candidates = signatures.filter((s) => !s.err).map((s) => s.signature);

    // Skip transactions already processed (token creations OR trades recorded).
    const { data: knownTokens } = await supabaseAdmin
      .from("pump_tokens")
      .select("signature")
      .in("signature", candidates);
    const { data: knownTrades } = await supabaseAdmin
      .from("pump_trades")
      .select("signature")
      .in("signature", candidates);
    const knownSet = new Set([
      ...(knownTokens ?? []).map((k) => k.signature),
      ...(knownTrades ?? []).map((k) => k.signature),
    ]);
    const fresh = candidates.filter((s) => !knownSet.has(s)).slice(0, 15);

    const results = await Promise.all(
      fresh.map(async (signature) => {
        try {
          const tx = await rpc<{
            blockTime?: number;
            meta?: { logMessages?: string[] };
          } | null>(url, "getTransaction", [
            signature,
            { maxSupportedTransactionVersion: 0, encoding: "json" },
          ]);
          if (!tx?.meta?.logMessages) return null;
          const parsed = { create: null as CreateEvent | null, trade: null as TradeEvent | null };
          for (const log of tx.meta.logMessages) {
            if (!log.startsWith("Program data: ")) continue;
            const raw = decodeBase64(log.slice("Program data: ".length));
            if (!parsed.create) parsed.create = parseCreateEvent(raw);
            if (!parsed.trade) parsed.trade = parseTradeEvent(raw);
          }
          return { signature, blockTime: tx.blockTime, ...parsed };
        } catch {
          return null;
        }
      }),
    );

    scanned = fresh.length;
    const txs = results.filter((r): r is NonNullable<typeof r> => r !== null);

    const tokenRows = txs
      .filter((t) => t.create)
      .map((t) => ({
        mint: t.create!.mint,
        name: t.create!.name,
        symbol: t.create!.symbol,
        uri: t.create!.uri,
        creator: t.create!.creator,
        bonding_curve: t.create!.bondingCurve,
        signature: t.signature,
        block_time: t.blockTime
          ? new Date(t.blockTime * 1000).toISOString()
          : new Date().toISOString(),
      }));

    if (tokenRows.length > 0) {
      const { data, error } = await supabaseAdmin
        .from("pump_tokens")
        .upsert(tokenRows, { onConflict: "mint", ignoreDuplicates: true })
        .select("mint");
      if (error) throw error;
      inserted = data?.length ?? 0;
    }

    const tradeRows = txs
      .filter((t) => t.trade)
      .map((t) => ({
        mint: t.trade!.mint,
        is_buy: t.trade!.isBuy,
        sol_amount: t.trade!.solAmount,
        token_amount: t.trade!.tokenAmount,
        user_wallet: t.trade!.user,
        signature: t.signature,
        price_sol: t.trade!.priceSol,
        market_cap_sol: t.trade!.marketCapSol,
        trade_time: t.trade!.timestamp
          ? new Date(t.trade!.timestamp * 1000).toISOString()
          : new Date().toISOString(),
      }));

    if (tradeRows.length > 0) {
      const { data, error } = await supabaseAdmin
        .from("pump_trades")
        .upsert(tradeRows, {
          onConflict: "signature,mint,is_buy,sol_amount",
          ignoreDuplicates: true,
        })
        .select("id");
      if (error) throw error;
      tradesInserted = data?.length ?? 0;
    }

    // Housekeeping: drop trades older than 24h (roughly every 20th run).
    if (Math.random() < 0.05) {
      await supabaseAdmin
        .from("pump_trades")
        .delete()
        .lt("trade_time", new Date(Date.now() - 24 * 3600 * 1000).toISOString());
    }

    await supabaseAdmin.from("radar_state").upsert({
      key: "listener",
      value: { last_run: new Date().toISOString(), scanned, inserted, trades: tradesInserted },
    });

    return { ok: true, inserted, scanned, trades: tradesInserted };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "unknown_error",
      inserted,
      scanned,
      trades: tradesInserted,
    };
  }
});
