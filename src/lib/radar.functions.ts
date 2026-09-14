import { createServerFn } from "@tanstack/react-start";
import { base58Encode } from "./base58";

const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

type CreateEvent = {
  name: string;
  symbol: string;
  uri: string;
  mint: string;
  bondingCurve: string;
  creator: string;
};

function decodeBase64(input: string): Uint8Array {
  const binary = atob(input);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Decodes a Pump.fun anchor CreateEvent emitted as a `Program data:` log line. */
function parseCreateEvent(data: Uint8Array): CreateEvent | null {
  try {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 8; // anchor event discriminator
    const decoder = new TextDecoder();

    const readString = (): string => {
      const len = view.getUint32(offset, true);
      offset += 4;
      if (len > 200 || offset + len > data.length) throw new Error("bad string");
      const value = decoder.decode(data.subarray(offset, offset + len));
      offset += len;
      return value;
    };
    const readPubkey = (): string => {
      if (offset + 32 > data.length) throw new Error("bad pubkey");
      const value = base58Encode(data.subarray(offset, offset + 32));
      offset += 32;
      return value;
    };

    const name = readString();
    const symbol = readString();
    const uri = readString();
    const mint = readPubkey();
    const bondingCurve = readPubkey();
    const creator = readPubkey();

    if (!uri.startsWith("http") && !uri.startsWith("ipfs")) return null;
    return { name, symbol, uri, mint, bondingCurve, creator };
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
  if (!apiKey) return { ok: false, error: "missing_rpc_key", inserted: 0, scanned: 0 };

  const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  let scanned = 0;
  let inserted = 0;

  try {
    const signatures = await rpc<Array<{ signature: string; err: unknown }>>(
      url,
      "getSignaturesForAddress",
      [PUMP_PROGRAM, { limit: 25 }],
    );
    const candidates = signatures.filter((s) => !s.err).map((s) => s.signature);

    const { data: known } = await supabaseAdmin
      .from("pump_tokens")
      .select("signature")
      .in("signature", candidates);
    const knownSet = new Set((known ?? []).map((k) => k.signature));
    const fresh = candidates.filter((s) => !knownSet.has(s)).slice(0, 12);

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
          for (const log of tx.meta.logMessages) {
            if (!log.startsWith("Program data: ")) continue;
            const event = parseCreateEvent(decodeBase64(log.slice("Program data: ".length)));
            if (event) {
              return {
                mint: event.mint,
                name: event.name,
                symbol: event.symbol,
                uri: event.uri,
                creator: event.creator,
                bonding_curve: event.bondingCurve,
                signature,
                block_time: tx.blockTime
                  ? new Date(tx.blockTime * 1000).toISOString()
                  : new Date().toISOString(),
              };
            }
          }
          return null;
        } catch {
          return null;
        }
      }),
    );

    scanned = fresh.length;
    const rows = results.filter((r): r is NonNullable<typeof r> => r !== null);

    if (rows.length > 0) {
      const { data, error } = await supabaseAdmin
        .from("pump_tokens")
        .upsert(rows, { onConflict: "mint", ignoreDuplicates: true })
        .select("mint");
      if (error) throw error;
      inserted = data?.length ?? 0;
    }

    await supabaseAdmin
      .from("radar_state")
      .upsert({ key: "listener", value: { last_run: new Date().toISOString(), scanned, inserted } });

    return { ok: true, inserted, scanned };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "unknown_error",
      inserted,
      scanned,
    };
  }
});
