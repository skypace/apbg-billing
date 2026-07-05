-- Fix compact Alameda Soda pack-code parsing.
--
-- Item names such as 24P121091 mean 24 x 12 oz, where the digits after P
-- continue into the SKU suffix. Limit the ounce capture to one or two digits
-- so the BOM scaler can derive finished volume correctly.

CREATE OR REPLACE FUNCTION ops.fn_bom_item_volume_fl_oz(
  p_name text,
  p_type text DEFAULT NULL
) RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_name text := trim(COALESCE(p_name, ''));
  v_scan text;
  v_type text := lower(COALESCE(p_type, ''));
  v_match text[];
  v_unit text;
  v_a numeric;
  v_b numeric;
BEGIN
  IF v_name = '' OR v_type IN ('service', 'category') THEN
    RETURN NULL;
  END IF;
  v_scan := replace(v_name, chr(215), 'x');

  v_match := regexp_match(v_scan, '\(([0-9]+[.]?[0-9]*)\s*[x*]\s*([0-9]+[.]?[0-9]*)\s*(fl\s*oz|oz|gal|l|ml)\s*\)', 'i');
  IF v_match IS NOT NULL THEN
    v_a := v_match[1]::numeric;
    v_b := v_match[2]::numeric;
    v_unit := lower(regexp_replace(v_match[3], '\s+', '', 'g'));
    IF v_unit IN ('floz', 'oz') THEN RETURN v_a * v_b; END IF;
    IF v_unit = 'gal' THEN RETURN v_a * v_b * 128; END IF;
    IF v_unit = 'l' THEN RETURN v_a * v_b * 33.8140227; END IF;
    IF v_unit = 'ml' THEN RETURN v_a * v_b * 0.0338140227; END IF;
  END IF;

  v_match := regexp_match(v_scan, '^([0-9]+[.]?[0-9]*)\s*G(NS?)?[0-9]', 'i');
  IF v_match IS NOT NULL THEN
    RETURN v_match[1]::numeric * 128;
  END IF;

  v_match := regexp_match(v_scan, '^([0-9]+[.]?[0-9]*)\s*L[0-9]', 'i');
  IF v_match IS NOT NULL THEN
    RETURN v_match[1]::numeric * 33.8140227;
  END IF;

  v_match := regexp_match(v_scan, '^([0-9]+)\s*PK([0-9]{1,2})', 'i');
  IF v_match IS NULL THEN
    v_match := regexp_match(v_scan, '^([0-9]+)\s*P([0-9]{1,2})', 'i');
  END IF;
  IF v_match IS NOT NULL THEN
    v_a := v_match[1]::numeric;
    v_b := v_match[2]::numeric;
    IF v_b BETWEEN 6 AND 32 THEN
      RETURN v_a * v_b;
    END IF;
  END IF;

  v_match := regexp_match(v_scan, '^([0-9]+[.]?[0-9]*)\s*OZ\s+(CAN|BTL|BOTTLE|CUP|MUG|GLASS)', 'i');
  IF v_match IS NOT NULL THEN
    RETURN v_match[1]::numeric;
  END IF;

  RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION ops.fn_bom_item_volume_fl_oz(text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
