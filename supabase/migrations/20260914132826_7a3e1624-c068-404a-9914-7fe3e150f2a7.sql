CREATE TABLE public.pump_tokens (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  mint TEXT NOT NULL UNIQUE,
  name TEXT,
  symbol TEXT,
  uri TEXT,
  creator TEXT,
  bonding_curve TEXT,
  signature TEXT,
  block_time TIMESTAMP WITH TIME ZONE,
  detected_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_pump_tokens_detected_at ON public.pump_tokens (detected_at DESC);

GRANT SELECT ON public.pump_tokens TO anon;
GRANT SELECT ON public.pump_tokens TO authenticated;
GRANT ALL ON public.pump_tokens TO service_role;

ALTER TABLE public.pump_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view detected tokens"
ON public.pump_tokens FOR SELECT
USING (true);

CREATE TABLE public.radar_state (
  key TEXT NOT NULL PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT ON public.radar_state TO anon;
GRANT SELECT ON public.radar_state TO authenticated;
GRANT ALL ON public.radar_state TO service_role;

ALTER TABLE public.radar_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view radar state"
ON public.radar_state FOR SELECT
USING (true);

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_pump_tokens_updated_at
BEFORE UPDATE ON public.pump_tokens
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_radar_state_updated_at
BEFORE UPDATE ON public.radar_state
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();