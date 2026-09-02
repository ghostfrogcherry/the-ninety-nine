import Link from "next/link";

import {
  COLORS, FINISHES, RARITIES, SORT_LABELS, TYPES,
  type Filters, type View,
} from "@/lib/collection/filters";

/**
 * The filter bar.
 *
 * A plain GET <form>, deliberately. Every control is a native input, so state
 * ends up in the query string, the page stays a server component with zero
 * client JS, and any filtered view is a URL you can bookmark or send to someone.
 * Checkboxes sharing a name produce repeated params, which parseFilters expects.
 */
export function FilterBar({
  filters,
  sets,
  action,
}: {
  filters: Filters;
  sets: string[];
  action: string;
}) {
  return (
    <form className="filters" method="get" action={action}>
      {/* View is toggled by the links below, but must survive an Apply. */}
      <input type="hidden" name="view" value={filters.view} />

      <fieldset>
        <legend>Search</legend>
        <input
          type="text"
          name="q"
          defaultValue={filters.q}
          placeholder="name or type…"
          style={{ minWidth: "16rem" }}
          aria-label="Search by card name or type"
        />
        <select name="set" defaultValue={filters.set} aria-label="Set">
          <option value="">all sets</option>
          {sets.map((s) => (
            <option key={s} value={s}>{s.toUpperCase()}</option>
          ))}
        </select>
      </fieldset>

      <fieldset>
        <legend>Colour</legend>
        {COLORS.map((c) => (
          <Chip key={c} name="colors" value={c} checked={filters.colors.includes(c)} label={c} />
        ))}
        <Chip name="colorless" value="1" checked={filters.colorless} label="Colourless" />
      </fieldset>

      <fieldset>
        <legend>Rarity</legend>
        {RARITIES.map((r) => (
          <Chip key={r} name="rarities" value={r} checked={filters.rarities.includes(r)} label={r} />
        ))}
      </fieldset>

      <fieldset>
        <legend>Type</legend>
        {TYPES.map((t) => (
          <Chip key={t} name="types" value={t} checked={filters.types.includes(t)} label={t} />
        ))}
      </fieldset>

      <fieldset>
        <legend>Finish</legend>
        {FINISHES.map((f) => (
          <Chip key={f} name="finishes" value={f} checked={filters.finishes.includes(f)} label={f} />
        ))}
      </fieldset>

      <fieldset>
        <legend>Range</legend>
        <span style={{ color: "var(--dim)", fontSize: 12 }}>mana</span>
        <input type="number" name="cmcMin" min={0} step={1} defaultValue={filters.cmcMin ?? ""} placeholder="min" aria-label="Minimum mana value" />
        <input type="number" name="cmcMax" min={0} step={1} defaultValue={filters.cmcMax ?? ""} placeholder="max" aria-label="Maximum mana value" />
        <span style={{ color: "var(--dim)", fontSize: 12, marginLeft: "0.6rem" }}>price $</span>
        <input type="number" name="priceMin" min={0} step="0.01" defaultValue={filters.priceMin ?? ""} placeholder="min" aria-label="Minimum price" />
        <input type="number" name="priceMax" min={0} step="0.01" defaultValue={filters.priceMax ?? ""} placeholder="max" aria-label="Maximum price" />
      </fieldset>

      <fieldset style={{ marginBottom: 0 }}>
        <legend>Sort</legend>
        <select name="sort" defaultValue={filters.sort} aria-label="Sort order">
          {SORT_LABELS.map(([k, label]) => (
            <option key={k} value={k}>{label}</option>
          ))}
        </select>
        <button type="submit">Apply</button>
        <Link href={action} style={{ fontSize: 12, marginLeft: "0.5rem", color: "var(--dim)" }}>
          clear
        </Link>
      </fieldset>
    </form>
  );
}

function Chip({ name, value, checked, label }: {
  name: string; value: string; checked: boolean; label: string;
}) {
  return (
    <label className="chip">
      {/* defaultChecked, not checked: this is an uncontrolled server-rendered
          form, and `checked` without onChange would make React warn. */}
      <input type="checkbox" name={name} value={value} defaultChecked={checked} />
      <span>{label}</span>
    </label>
  );
}

/** Grid/table switch. Links rather than form controls so it applies instantly
 *  and keeps every other filter in the URL. */
export function ViewToggle({ current, hrefFor }: {
  current: View; hrefFor: (v: View) => string;
}) {
  return (
    <span style={{ display: "inline-flex", gap: "0.4rem", fontSize: 12 }}>
      {(["grid", "table"] as const).map((v) => (
        <Link
          key={v}
          href={hrefFor(v)}
          style={{
            color: v === current ? "var(--yellow)" : "var(--dim)",
            borderBottom: v === current ? "1px solid var(--yellow)" : "1px solid transparent",
          }}
        >
          {v}
        </Link>
      ))}
    </span>
  );
}
