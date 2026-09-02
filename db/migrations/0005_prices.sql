-- 0005_prices.sql
--
-- Price history, snapshotted from the local Scryfall mirror on each weekly
-- refresh. No live per-card API calls, ever.
--
-- scryfall_cards.prices only ever holds the CURRENT values and is overwritten
-- by the refresh, so history has to be copied out before it is clobbered.

CREATE TABLE card_price_history (
  scryfall_id UUID NOT NULL,

  -- Finish matters: in the real collection, foil and non-foil of the same
  -- printing carry different prices (Makindi Stampede (ZNR) 26 is $0.35 plain
  -- and $0.79 foil). Scryfall exposes these as separate `usd` / `usd_foil`
  -- fields, so a single price per printing would be wrong.
  finish      TEXT NOT NULL,

  recorded_on DATE NOT NULL,

  -- NUMERIC, not float: these are money. Scryfall ships them as JSON strings
  -- and any of them may be null for a card with no recorded sale.
  usd         NUMERIC(10,2),
  eur         NUMERIC(10,2),
  tix         NUMERIC(10,2),

  PRIMARY KEY (scryfall_id, finish, recorded_on)
);

-- Charting a card's price walks one id forward through time.
CREATE INDEX card_price_history_id_date_idx ON card_price_history (scryfall_id, recorded_on DESC);
-- "What did the whole collection swing this week" scans a single day.
CREATE INDEX card_price_history_date_idx ON card_price_history (recorded_on);

-- Convenience view: current value of every collection, computed from the most
-- recent snapshot per (card, finish).
CREATE VIEW collection_values AS
SELECT
  c.id   AS collection_id,
  c.user_id,
  c.name AS collection_name,
  COUNT(*)                          AS distinct_printings,
  SUM(cc.quantity)                  AS physical_cards,
  SUM(cc.quantity * COALESCE(p.usd, 0)) AS total_usd
FROM collections c
JOIN collection_cards cc ON cc.collection_id = c.id
LEFT JOIN LATERAL (
  SELECT h.usd
  FROM card_price_history h
  WHERE h.scryfall_id = cc.scryfall_id
    AND h.finish      = cc.finish
  ORDER BY h.recorded_on DESC
  LIMIT 1
) p ON TRUE
GROUP BY c.id, c.user_id, c.name;
