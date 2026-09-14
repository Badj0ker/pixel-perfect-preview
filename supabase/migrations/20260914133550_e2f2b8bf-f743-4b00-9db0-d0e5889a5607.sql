CREATE TABLE public.pump_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mint text NOT NULL,
  is_buy boolean NOT NULL,
  sol_amount numeric NOT NULL DEFAULT 0,
  token_amount numeric NOT NULL DEFAULT 0,
  user_wallet text,
  signature text NOT NULL,
  price_sol numeric,
  market_cap_sol numeric,
  trade_time timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX pump_trades_sig_mint_idx ON public.pump_trades (signature, mint, is_buy, sol_amount);
CREATE INDEX pump_trades_mint_time_idx ON public.pump_trades (mint, trade_time DESC);
CREATE INDEX pump_trades_time_idx ON public.pump_trades (trade_time DESC);

GRANT SELECT ON public.pump_trades TO anon;
GRANT SELECT ON public.pump_trades TO authenticated;
GRANT ALL ON public.pump_trades TO service_role;

ALTER TABLE public.pump_trades ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view trades" ON public.pump_trades FOR SELECT USING (true);

ALTER TABLE public.pump_tokens
  ADD COLUMN buy_count integer NOT NULL DEFAULT 0,
  ADD COLUMN sell_count integer NOT NULL DEFAULT 0,
  ADD COLUMN buy_volume_sol numeric NOT NULL DEFAULT 0,
  ADD COLUMN sell_volume_sol numeric NOT NULL DEFAULT 0,
  ADD COLUMN volume_sol numeric NOT NULL DEFAULT 0,
  ADD COLUMN last_trade_at timestamp with time zone,
  ADD COLUMN price_sol numeric,
  ADD COLUMN market_cap_sol numeric;

CREATE OR REPLACE FUNCTION public.apply_trade_to_token()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE public.pump_tokens t
  SET
    buy_count = t.buy_count + CASE WHEN NEW.is_buy THEN 1 ELSE 0 END,
    sell_count = t.sell_count + CASE WHEN NEW.is_buy THEN 0 ELSE 1 END,
    buy_volume_sol = t.buy_volume_sol + CASE WHEN NEW.is_buy THEN NEW.sol_amount ELSE 0 END,
    sell_volume_sol = t.sell_volume_sol + CASE WHEN NEW.is_buy THEN 0 ELSE NEW.sol_amount END,
    volume_sol = t.volume_sol + NEW.sol_amount,
    last_trade_at = GREATEST(COALESCE(t.last_trade_at, NEW.trade_time), NEW.trade_time),
    price_sol = COALESCE(NEW.price_sol, t.price_sol),
    market_cap_sol = COALESCE(NEW.market_cap_sol, t.market_cap_sol),
    updated_at = now()
  WHERE t.mint = NEW.mint;
  RETURN NEW;
END;
$$;

CREATE TRIGGER pump_trades_apply_to_token
AFTER INSERT ON public.pump_trades
FOR EACH ROW EXECUTE FUNCTION public.apply_trade_to_token();