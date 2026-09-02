-- 0006_collection_values_fallback.sql
--
-- Make collection_values fall back to the CURRENT mirror price when no history
-- row exists yet.
--
-- Why this was wrong: the weekly refresh snapshots OUTGOING prices — it copies
-- what scryfall_cards held before overwriting it. On a brand-new install the
-- mirror starts empty, so the first refresh has nothing to preserve and
-- correctly writes zero history rows. card_price_history therefore stays empty
-- until the SECOND refresh, a week later.
--
-- The practical effect was that a freshly imported 1457-card collection valued
-- itself at $0.00 on /collections for a week, while the per-collection card
-- view — which reads scryfall_cards.prices directly — showed real money. Two
-- pages disagreeing about the same collection.
--
-- The fix is a COALESCE, not a pipeline change: history still wins when it
-- exists (it is dated, and is the right answer for "what was this worth then"),
-- and the live mirror fills the gap until there is any.

CREATE OR REPLACE VIEW collection_values AS
SELECT
  c.id   AS collection_id,
  c.user_id,
  c.name AS collection_name,
  COUNT(*)         AS distinct_printings,
  SUM(cc.quantity) AS physical_cards,
  SUM(
    cc.quantity * COALESCE(
      h.usd,
      -- Finish-aware, same as everywhere else: the foil of a printing is a
      -- different price from the non-foil, and collapsing them undervalues
      -- foil-heavy collections.
      CASE
        WHEN cc.finish = 'foil'   THEN (s.prices->>'usd_foil')::numeric
        WHEN cc.finish = 'etched' THEN (s.prices->>'usd_etched')::numeric
        ELSE (s.prices->>'usd')::numeric
      END,
      0
    )
  ) AS total_usd
FROM collections c
JOIN collection_cards cc ON cc.collection_id = c.id
-- LEFT JOIN: a card the mirror has never heard of must still contribute its
-- quantity to the counts rather than drop the whole row from the total.
LEFT JOIN scryfall_cards s ON s.id = cc.scryfall_id
LEFT JOIN LATERAL (
  SELECT h.usd
  FROM card_price_history h
  WHERE h.scryfall_id = cc.scryfall_id
    AND h.finish      = cc.finish
  ORDER BY h.recorded_on DESC
  LIMIT 1
) h ON TRUE
GROUP BY c.id, c.user_id, c.name;
