import { BUILTIN_PRESETS, CrawlConfigSchema, type Preset, type UpsertPreset } from '@hype/shared';
import { and, asc, eq, notInArray } from 'drizzle-orm';
import type { Db } from '../client.js';
import { presets } from '../schema.js';

export class SqlitePresetRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  /**
   * Yerleşik presetleri kurar.
   *
   * Var olan kayıtların AYARLARI yeniden yazılmaz — kullanıcı bir yerleşik
   * preseti kendine göre düzenlediyse her açılışta geri alınması can sıkıcı
   * olurdu. Açıklama metni ise güncellenir: o kullanıcı verisi değil, bizim
   * anlattığımız şey.
   *
   * Sürümler arasında yeniden adlandırılan yerleşikler temizlenir; aksi hâlde
   * listede hem eski hem yeni ad birlikte görünürdü.
   */
  seedBuiltins(): void {
    const now = this.now();
    const names = BUILTIN_PRESETS.map((p) => p.name);

    this.db
      .delete(presets)
      .where(and(eq(presets.builtin, true), notInArray(presets.name, names)))
      .run();

    for (const preset of BUILTIN_PRESETS) {
      const existing = this.db.select().from(presets).where(eq(presets.name, preset.name)).get();

      if (existing === undefined) {
        this.db
          .insert(presets)
          .values({
            name: preset.name,
            description: preset.description,
            configJson: JSON.stringify(CrawlConfigSchema.parse(preset.config)),
            builtin: true,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        continue;
      }

      /*
       * Kayıtlı ayar korunur ama YENİ ALANLAR doldurulur.
       *
       * Bu, yukarıdaki "kullanıcı düzenlemesini ezme" kuralıyla çelişmiyor:
       * preset kaydedildiğinde var olmayan bir alan hiç düzenlenmemiştir.
       * Doldurmazsak yerleşik preset kendi açıklamasını yalanlar — örneğin
       * "Türkçe içerik" preseti "Türkiye'den bakılıyor" der ama bölge boş kalır.
       */
      const merged = { ...preset.config, ...safeParseConfig(existing.configJson) };
      this.db
        .update(presets)
        .set({
          description: preset.description,
          configJson: JSON.stringify(CrawlConfigSchema.parse(merged)),
          updatedAt: now,
        })
        .where(eq(presets.id, existing.id))
        .run();
    }
  }

  list(): Preset[] {
    return this.db.select().from(presets).orderBy(asc(presets.id)).all().map(toPreset);
  }

  get(id: number): Preset | null {
    const row = this.db.select().from(presets).where(eq(presets.id, id)).get();
    return row === undefined ? null : toPreset(row);
  }

  /** Ad zaten kullanılıyor mu? (kendisi hariç) */
  nameTaken(name: string, exceptId?: number): boolean {
    const row = this.db.select().from(presets).where(eq(presets.name, name)).get();
    return row !== undefined && row.id !== exceptId;
  }

  create(input: UpsertPreset): Preset {
    const now = this.now();
    const row = this.db
      .insert(presets)
      .values({
        name: input.name,
        description: input.description ?? null,
        configJson: JSON.stringify(input.config),
        builtin: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return toPreset(row);
  }

  update(id: number, input: UpsertPreset): Preset | null {
    const row = this.db
      .update(presets)
      .set({
        name: input.name,
        description: input.description ?? null,
        configJson: JSON.stringify(input.config),
        updatedAt: this.now(),
      })
      .where(eq(presets.id, id))
      .returning()
      .get();
    return row === undefined ? null : toPreset(row);
  }

  /** Yerleşik presetler silinemez: arayüzün her zaman bir başlangıç noktası olmalı. */
  delete(id: number): boolean {
    const existing = this.get(id);
    if (existing === null || existing.builtin) return false;
    this.db.delete(presets).where(eq(presets.id, id)).run();
    return true;
  }
}

/**
 * Kayıtlı ayarı HAM okur — şemadan geçirmeden.
 *
 * Kasıtlı: `CrawlConfigSchema.parse` eksik alanları varsayılanla doldurur ve o
 * varsayılan, yerleşik presetin kendi değerini ezerdi. Birleştirmede "kullanıcı
 * gerçekten ne kaydetmiş" bilgisine ihtiyacımız var.
 */
function safeParseConfig(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toPreset(row: typeof presets.$inferSelect): Preset {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    config: CrawlConfigSchema.parse(JSON.parse(row.configJson)),
    builtin: row.builtin,
  };
}
