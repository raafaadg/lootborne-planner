import index from '../../../game-data/icons/index.json';
import itemsSheet from '../../../game-data/icons/items.png';
import perksSheet from '../../../game-data/icons/perks.png';
import consumablesSheet from '../../../game-data/icons/consumables.png';
import { cn } from './ui';

/**
 * The game's own art, extracted by spikes/s7_icons.py into one sheet per family. Each sheet is the
 * pixel art at its native size, so it is drawn with `pixelated` and only ever scaled by whole steps.
 */
export type IconFamily = 'items' | 'perks' | 'consumables';

interface SheetMeta {
  cols: number;
  cell: number[];
  count: number;
  ids: number[];
}

const SHEETS: Record<IconFamily, { url: string; meta: SheetMeta; pos: Map<number, number> }> = {
  items: sheetOf('items', itemsSheet),
  perks: sheetOf('perks', perksSheet),
  consumables: sheetOf('consumables', consumablesSheet),
};

function sheetOf(family: IconFamily, url: string) {
  const meta = (index as unknown as Record<string, SheetMeta>)[family]!;
  return { url, meta, pos: new Map(meta.ids.map((id, i) => [id, i])) };
}

export function hasIcon(family: IconFamily, id: number | undefined): boolean {
  return id !== undefined && SHEETS[family].pos.has(id);
}

/**
 * One icon from a sheet. `scale` multiplies the native pixel size, so 2 doubles it without blurring.
 * Unknown ids render nothing, which keeps the callers free of conditionals.
 */
export function Icon({
  family,
  id,
  scale = 1,
  title,
  className,
}: {
  family: IconFamily;
  id: number | undefined;
  scale?: number;
  title?: string;
  className?: string;
}) {
  const s = SHEETS[family];
  const i = id === undefined ? undefined : s.pos.get(id);
  const w = s.meta.cell[0]!;
  const h = s.meta.cell[1]!;
  if (i === undefined) return <span className={cn('inline-block shrink-0', className)} style={{ width: w * scale, height: h * scale }} />;
  const col = i % s.meta.cols;
  const row = Math.floor(i / s.meta.cols);
  const rows = Math.ceil(s.meta.count / s.meta.cols);
  return (
    <span
      title={title}
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      className={cn('inline-block shrink-0 bg-no-repeat align-middle', className)}
      style={{
        width: w * scale,
        height: h * scale,
        backgroundImage: `url(${s.url})`,
        backgroundSize: `${s.meta.cols * w * scale}px ${rows * h * scale}px`,
        backgroundPosition: `-${col * w * scale}px -${row * h * scale}px`,
        imageRendering: 'pixelated',
      }}
    />
  );
}
