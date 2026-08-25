import {
  CRAWL_LANGUAGES,
  CrawlConfigSchema,
  languageForRegion,
  type Preset,
  REGIONS,
} from '@hype/shared';
import { useEffect, useState } from 'react';
import { BoundedField, Button, cx, Field, NumberInput, Toggle } from '../../components/ui.js';
import { ApiError, api } from '../../lib/api.js';
import { countdown } from '../../lib/format.js';
import { useRealtime } from '../../store/realtime.js';

type Draft = Record<string, unknown>;

/** Yazarken öneri çıkması için; liste kısıtlayıcı değil, istediğinizi yazabilirsiniz. */
const COUNTRY_SUGGESTIONS = [
  'Türkiye',
  'United States',
  'Germany',
  'United Kingdom',
  'France',
  'Netherlands',
  'Azerbaijan',
  'Russia',
  'Spain',
  'Italy',
  'Japan',
  'South Korea',
  'India',
  'Brazil',
];

function parseTerms(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((term) => term.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Kontrol paneli.
 *
 * Doğrulama tek kaynaktan: aynı `CrawlConfigSchema` hem burada hem sunucuda
 * çalışıyor. Sunucudan dönen alan-alan hatalar forma geri basılıyor, böylece
 * "neden başlamadı?" sorusu hiç doğmuyor.
 */
export function ControlPanel({ onToast }: { onToast: (message: string) => void }) {
  const phase = useRealtime((s) => s.phase);
  const cooldownUntil = useRealtime((s) => s.cooldownUntil);
  const statusDetail = useRealtime((s) => s.statusDetail);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<Preset | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  /**
   * Tıklanan ama motorun henüz uygulamadığı komut.
   *
   * Hız sınırı yüzünden motor bir isteği bitirmeden duramıyor; bu birkaç
   * saniye sürebiliyor. Geri bildirim olmadan kullanıcı butonu bozuk sanıyor.
   */
  const [bekleyenKomut, setBekleyenKomut] = useState<'pause' | 'resume' | 'stop' | null>(null);

  // Motor komutu uyguladığında bekleme durumu kalkar. `phase` bir bağımlılık
  // değil, TETİKLEYİCİ: efektin gövdesi onu okumuyor ama faz her değiştiğinde
  // yeniden çalışması gerekiyor.
  // biome-ignore lint/correctness/useExhaustiveDependencies: faz değişimi tetikleyici
  useEffect(() => {
    setBekleyenKomut(null);
  }, [phase]);

  useEffect(() => {
    void api.defaults().then((config) =>
      // Tohum alanı BOŞ başlar: kullanıcı kendi terimlerini yazsın diye. Boş
      // bırakılırsa sunucu varsayılan konulara düşüyor, yani tarama yine başlar.
      setDraft({ ...(config as unknown as Draft), seedQueries: [] }),
    );
    void api.presets().then((r) => setPresets(r.presets));
  }, []);

  const busy = phase !== 'idle' && phase !== 'stopped';
  const locked = busy || pending;
  const kanalModu = draft?.mode === 'channel';

  if (draft === null) {
    return <div className="p-4 text-muted text-sm">yükleniyor…</div>;
  }

  const set = (key: string, value: unknown): void => {
    /*
     * Elle yapılan her değişiklik hazır ayar seçimini düşürür. Aksi hâlde
     * kutuda "Yükselen kanallar" yazarken taslak artık o preset değildir ve
     * ekran yalan söyler — kullanıcının "kanal modu presetten mi Av modundan
     * mı seçiliyor" diye sormasının sebebi tam olarak buydu.
     */
    setSelectedPreset(null);
    setDraft({ ...draft, [key]: value });
    setErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const num = (key: string) => Number(draft[key] ?? 0);
  /** Kapatılabilir sınırlar null taşıyabilir. */
  const bound = (key: string): number | null => {
    const value = draft[key];
    return value === null || value === undefined ? null : Number(value);
  };

  async function start(): Promise<void> {
    const current = draft;
    if (current === null) return;
    setPending(true);
    setErrors({});

    // Tohum alanı boşsa taramayı engellemek yerine varsayılan konulara düşüyoruz:
    // "hiçbir şey yazmadan da başlayabilmeli" beklentisi doğru olan.
    const seeds = current.seedQueries;
    const payload =
      Array.isArray(seeds) && seeds.length > 0 ? current : { ...current, seedQueries: undefined };
    const parsed = CrawlConfigSchema.safeParse(payload);
    if (!parsed.success) {
      // İstemci tarafı doğrulama: sunucuya gitmeden anında geri bildirim.
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? '');
        fieldErrors[key] = issue.message;
      }
      setErrors(fieldErrors);
      setPending(false);
      return;
    }

    try {
      await api.startRun(parsed.data);
    } catch (error) {
      if (error instanceof ApiError && error.problem.issues !== undefined) {
        const fieldErrors: Record<string, string> = {};
        for (const issue of error.problem.issues) {
          fieldErrors[issue.path.replace(/^\//, '')] = issue.message;
        }
        setErrors(fieldErrors);
      }
      onToast(error instanceof Error ? error.message : 'Tarama başlatılamadı');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StatusPill phase={phase} cooldownUntil={cooldownUntil} detail={statusDetail} />

      <DisabledFilterNotice draft={draft} />

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {presets.length > 0 && (
          <Field label="Hazır ayar">
            <select
              disabled={locked}
              value={selectedPreset === null ? '' : String(selectedPreset.id)}
              onChange={(event) => {
                const preset = presets.find((p) => String(p.id) === event.target.value);
                setSelectedPreset(preset ?? null);
                if (preset !== undefined) setDraft(preset.config as unknown as Draft);
              }}
              className="w-full rounded border border-line bg-bg px-2 py-1.5 text-[13px] outline-none focus:border-accent disabled:opacity-50"
            >
              <option value="">— seç —</option>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
            {selectedPreset?.description != null && (
              <p className="mt-1 text-[11px] text-muted leading-snug">
                {selectedPreset.description}
              </p>
            )}
          </Field>
        )}

        <Field
          label="Av modu"
          help="Video avı: bir videonun, KENDİ kanalının normalinin kaç katını aldığını arar. Kanal avı: kısa sürede açılmış ve neredeyse HER videosu tutan kanalları arar — video avının yapısal olarak göremediği şey budur, çünkü her videosu tutan bir kanalın medyanı zaten yüksektir ve hiçbir videosu sivrilmez."
        >
          <select
            disabled={locked}
            value={String(draft.mode ?? 'video')}
            onChange={(event) => {
              const mode = event.target.value;
              /*
               * Kanal avında abone aralığı varsayılan olarak KAPANIR. Aranan
               * şey "kısa sürede açılmış ama çok izlenen kanal"; böyle bir
               * kanalın abone sayısı tanımı gereği öngörülemez — üst sınır tam
               * da bulmak istediğimiz kanalı eler. İstek de tasarruf etmiyor:
               * abone, kanal zaten çekildikten sonra bakılan bir alan.
               */
              setSelectedPreset(null);
              setDraft(
                mode === 'channel'
                  ? { ...draft, mode, minSubs: null, maxSubs: null }
                  : { ...draft, mode },
              );
            }}
            className="w-full rounded border border-line bg-bg px-2 py-1.5 text-[13px] outline-none focus:border-accent disabled:opacity-50"
          >
            <option value="video">Video avı — patlayan tek videolar</option>
            <option value="channel">Kanal avı — yükselen kanallar</option>
          </select>
        </Field>

        <Field
          label="Tohum terimleri"
          hint="arama başlangıçları"
          help="Tarama nereden başlasın? Bu terimlerle YouTube'da arama yapılır ve çıkan videolardan biri başlangıç noktası olur. Terimlerin dili taramanın gireceği içerik bölgesini belirler."
          error={errors.seedQueries}
        >
          <textarea
            disabled={locked}
            rows={3}
            value={(draft.seedQueries as string[] | undefined)?.join('\n') ?? ''}
            onChange={(event) =>
              set(
                'seedQueries',
                event.target.value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter((line) => line.length > 0),
              )
            }
            placeholder={'belgesel\nyemek tarifi\ngezi'}
            className="w-full rounded border border-line bg-bg px-2 py-1.5 font-mono text-[12px] outline-none focus:border-accent disabled:opacity-50"
          />
        </Field>

        <div className="space-y-2 border-line border-y bg-panel/40 py-2">
          <div className="flex items-baseline justify-between">
            <span className="font-semibold text-[11px] text-ink uppercase">Niş kapısı</span>
            <span className="text-[10px] text-muted">sonuçları konu içinde tutar</span>
          </div>
          <Field
            label="Hedef terimler"
            hint="boşsa tohumlardan alınır"
            help="Bir sonuç ancak başlığı veya kanal adı bu terimlerden en az biriyle eşleşirse skorlanır. Boş bırakırsanız yazdığınız tohum terimleri otomatik kullanılır; varsayılan geniş taramada konu kapısı kapanır. Virgül ya da yeni satırla ayırabilirsiniz."
            error={errors.topicIncludeTerms}
          >
            <textarea
              disabled={locked}
              rows={2}
              value={((draft.topicIncludeTerms as string[] | undefined) ?? []).join('\n')}
              onChange={(event) => set('topicIncludeTerms', parseTerms(event.target.value))}
              placeholder={'elektrikli araç\nbatarya teknolojisi'}
              className="w-full rounded border border-line bg-bg px-2 py-1.5 font-mono text-[12px] outline-none focus:border-accent disabled:opacity-50"
            />
          </Field>
          <Field
            label="Hariç tut"
            hint="isteğe bağlı"
            help="Bu terimlerden biri geçerse sonuç ve o dal anında elenir. Örneğin müzik, remix, karaoke."
            error={errors.topicExcludeTerms}
          >
            <input
              disabled={locked}
              value={((draft.topicExcludeTerms as string[] | undefined) ?? []).join(', ')}
              onChange={(event) => set('topicExcludeTerms', parseTerms(event.target.value))}
              placeholder="müzik, remix, karaoke"
              className="w-full rounded border border-line bg-bg px-2 py-1.5 text-[12px] outline-none focus:border-accent disabled:opacity-50"
            />
          </Field>
          <Field
            label="Konu disiplini"
            help="Sıkı konu dışı köprüye izin vermez. Dengeli bir köprü adımıyla yakın alt konuları bulur. Keşif en fazla üç köprü adımı kullanır."
          >
            <select
              disabled={locked}
              value={String(draft.topicStrictness ?? 'balanced')}
              onChange={(event) => set('topicStrictness', event.target.value)}
              className="w-full rounded border border-line bg-bg px-2 py-1.5 text-[12px] outline-none focus:border-accent disabled:opacity-50"
            >
              <option value="strict">Sıkı — konu dışına çıkma</option>
              <option value="balanced">Dengeli — 1 köprü adımı</option>
              <option value="explore">Keşif — 3 köprü adımı</option>
            </select>
          </Field>
        </div>

        <Field
          label="Bölge (algoritma)"
          hint="etkisi sınırlı — bkz. açıklama"
          help="YouTube'a hangi ülkedeymişiz gibi görüneceğimiz; ilk istekten itibaren uygulanır. ETKİSİ ÖLÇÜLDÜ ve sınırlı çıktı: YouTube beyanı kabul ediyor, arama sonuçlarını bazı sorgularda değiştiriyor, ama öneri grafını neredeyse hiç kaydırmıyor (kendi ülkesinin kanallarını yalnızca ~5 puan öne çıkarıyor). İçeriğin bölgesini pratikte belirleyen şey hâlâ TOHUM TERİMLERİNİN DİLİ. Aşağıdaki 'Ülke' ile karıştırmayın: bu ALGORİTMAYA sorar, o ise sonuçtaki kanalları süzer."
          error={errors.region}
        >
          <select
            disabled={locked}
            value={(draft.region as string | null) ?? ''}
            onChange={(event) => {
              const code = event.target.value === '' ? null : event.target.value;
              /*
               * Bölge seçilince yürüyüş dili de ÖNERİLİYOR — asıl kaldıraç o.
               * Ölçüm bölge beyanının öneri grafını kaydırmadığını, ama hangi
               * kenardan yürüdüğümüzün tamamen bizde olduğunu gösterdi.
               * Kullanıcı zaten bir dil seçtiyse dokunulmuyor.
               */
              const suggested = languageForRegion(code);
              const current = draft.crawlLanguages as string[] | null;
              setDraft({
                ...draft,
                region: code,
                ...(suggested !== null && (current === null || current.length === 0)
                  ? { crawlLanguages: [suggested] }
                  : {}),
              });
            }}
            className="w-full rounded border border-line bg-bg px-2 py-1.5 text-[13px] outline-none focus:border-accent disabled:opacity-50"
          >
            <option value="">— varsayılan (ABD) —</option>
            {REGIONS.map((region) => (
              <option key={region.code} value={region.code}>
                {region.label}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Yürüyüş dili"
          hint="asıl bölge kaldıracı"
          help="Öneri rafında YALNIZCA bu dildeki videoların üstünden yürünür. Bölge beyanının aksine bu gerçekten işe yarıyor, çünkü Türkçe bir videonun komşuları zaten Türkçedir — sadece o kenarlardan yürürsek tarama o dilin alt-grafına yerleşir ve derinlik arttıkça saflaşır. Başlık zaten elimizde olduğu için BEDAVA: kanal isteği harcamaz. Sadece YÜRÜMEYİ engeller, elemez — yolda bulunan iyi bir video havuza girebilir. Derinliği 8-9 yapmak etkisini artırır."
          error={errors.crawlLanguages}
        >
          <select
            disabled={locked}
            value={((draft.crawlLanguages as string[] | null) ?? [])[0] ?? ''}
            onChange={(event) =>
              set('crawlLanguages', event.target.value === '' ? null : [event.target.value])
            }
            className="w-full rounded border border-line bg-bg px-2 py-1.5 text-[13px] outline-none focus:border-accent disabled:opacity-50"
          >
            <option value="">— dil filtresi yok —</option>
            {CRAWL_LANGUAGES.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.label}
              </option>
            ))}
          </select>
        </Field>

        {((draft.crawlLanguages as string[] | null) ?? []).length > 0 && (
          <Toggle
            checked={draft.allowUnknownLanguage !== false}
            onChange={(v) => set('allowUnknownLanguage', v)}
            label="dili anlaşılmayan videoların üstünden de yürü"
          />
        )}

        <Field
          label="Ülke (kanal filtresi)"
          hint="boşsa ülke filtresi yok"
          help="Yalnızca bu ülkelerdeki kanallar listeye girer. Ülke bilgisi ayrı bir istek gerektirdiği için EN SON sorulur — yani yalnızca diğer tüm filtreleri geçmiş adaylar için, ve kanal başına bir kez (sonuç kalıcı saklanır). Virgülle birden fazla ülke yazabilirsiniz."
          error={errors.countries}
        >
          <input
            disabled={locked}
            list="ulke-onerileri"
            value={((draft.countries as string[] | null) ?? []).join(', ')}
            onChange={(event) => {
              const list = event.target.value
                .split(',')
                .map((v) => v.trim())
                .filter((v) => v.length > 0);
              set('countries', list.length > 0 ? list : null);
            }}
            placeholder="örn. Türkiye"
            className="w-full rounded border border-line bg-bg px-2 py-1.5 text-[13px] outline-none focus:border-accent disabled:opacity-50"
          />
          <datalist id="ulke-onerileri">
            {COUNTRY_SUGGESTIONS.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>

        {(draft.countries as string[] | null) !== null && (
          <Toggle
            checked={draft.allowUnknownCountry === true}
            onChange={(v) => set('allowUnknownCountry', v)}
            label="ülkesini belirtmemiş kanalları da kabul et"
          />
        )}

        <div className="grid grid-cols-2 gap-2">
          <BoundedField
            label="Min abone"
            help="Bundan az aboneli kanallar elenir. Kapatırsanız (∞) alt sınır uygulanmaz."
            error={errors.minSubs}
            disabled={locked}
            value={bound('minSubs')}
            onChange={(v) => set('minSubs', v)}
            min={0}
          />
          <BoundedField
            label="Maks abone"
            help="Bundan çok aboneli kanallar elenir. Amaç küçük kanalları bulmak; kapatırsanız kanal boyutu hiç dikkate alınmaz."
            error={errors.maxSubs}
            disabled={locked}
            value={bound('maxSubs')}
            onChange={(v) => set('maxSubs', v)}
            min={100}
          />
        </div>

        {kanalModu ? (
          <ChannelModeFields draft={draft} set={set} errors={errors} locked={locked} num={num} />
        ) : (
          <Field
            label="Hype eşiği"
            hint={`${num('crawlThreshold')}x'te kaydedilir`}
            help="Bir video, kanalın normal izlenmesinin en az kaç katını almalı ki listeye girsin. 5x = kanalın normalinin beş katı."
            error={errors.hypeThreshold}
          >
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={2}
                max={25}
                step={0.5}
                disabled={locked}
                value={num('hypeThreshold')}
                onChange={(e) => set('hypeThreshold', Number(e.target.value))}
                className="flex-1 accent-[var(--color-accent)]"
              />
              <span className="tnum w-12 text-right text-[13px]">{num('hypeThreshold')}x</span>
            </div>
          </Field>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Field
            label="Maks derinlik"
            help="Öneri zincirinde kaç adım derine inilecek. Tohum videodan başlanır, önerilenlerinden birine geçilir, onun önerilenlerine inilir… Bu sınıra gelince yeni bir tohum alınır. Düşük tutmak çeşitliliği artırır: YouTube derine indikçe hep aynı tür içeriği önermeye başlar (yankı fanusu)."
            error={errors.maxDepth}
          >
            <NumberInput
              disabled={locked}
              min={2}
              max={8}
              value={num('maxDepth')}
              onChange={(e) => set('maxDepth', Number(e.target.value))}
            />
          </Field>
          <Field
            label="Maks video"
            help="Bu kadar video incelendikten sonra tarama durur."
            error={errors.maxVideosScanned}
          >
            <NumberInput
              disabled={locked}
              value={num('maxVideosScanned')}
              onChange={(e) => set('maxVideosScanned', Number(e.target.value))}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <BoundedField
            label="Maks yaş (gün)"
            help="Yalnızca son bu kadar günde yayımlanmış videolar değerlendirilir. Amaç güncel trendleri yakalamak; ayrıca YouTube 60 günden sonra tarihi '2 ay önce' gibi belirsiz gösterdiği için hesap bozulur."
            error={errors.maxVideoAgeDays}
            disabled={locked}
            value={bound('maxVideoAgeDays')}
            onChange={(v) => set('maxVideoAgeDays', v)}
            min={1}
          />
          <BoundedField
            label="Min izlenme"
            help="Bundan az izlenmiş videolar hiç incelenmez. Kanal sorgusu harcamamak için ucuz bir ön eleme."
            error={errors.minViews}
            disabled={locked}
            value={bound('minViews')}
            onChange={(v) => set('minViews', v)}
            min={0}
          />
        </div>

        <details className="rounded border border-line">
          <summary className="cursor-pointer px-2 py-1.5 text-[12px] text-muted">Gelişmiş</summary>
          <div className="space-y-2 border-line border-t p-2">
            <Field
              label="Kanal isteği bütçesi"
              hint="asıl maliyet kalemi"
              help="Sistemin TEK pahalı işlemi: bir kanalın abone sayısını ve normal izlenmesini öğrenmek için YouTube'a ayrı istek atmak. Diğer her şey elde olan veriden bedava hesaplanıyor. Bu sayı bir taramanın en fazla kaç kanal sorgulayabileceğini sınırlar; bitince tarama durur."
              error={errors.channelRequestBudget}
            >
              <NumberInput
                disabled={locked}
                value={num('channelRequestBudget')}
                onChange={(e) => set('channelRequestBudget', Number(e.target.value))}
              />
            </Field>
            <Field
              label="Toplam istek bütçesi"
              help="Bir taramanın toplam istek hakkı. Ban riskine karşı üst sınır."
              error={errors.requestBudget}
            >
              <NumberInput
                disabled={locked}
                value={num('requestBudget')}
                onChange={(e) => set('requestBudget', Number(e.target.value))}
              />
            </Field>
            <BoundedField
              label="Maks izlenme"
              hint="dev kanalları bedava eler"
              help="Bundan çok izlenmiş videolar elenir. Dev kanalların videolarını kanal sorgusu harcamadan ayıklar."
              error={errors.maxViews}
              disabled={locked}
              value={bound('maxViews')}
              onChange={(v) => set('maxViews', v)}
              min={1000}
            />
            <BoundedField
              label="Min hız (izlenme/gün)"
              help="Günlük izlenme hızı bundan düşük olan videolar elenir."
              error={errors.minVpd}
              disabled={locked}
              value={bound('minVpd')}
              onChange={(v) => set('minVpd', v)}
              min={0}
            />
            <BoundedField
              label="Min yaş (saat)"
              hint="çok taze videolar elenir"
              help="Bundan taze videolar elenir; birkaç saatlik bir videonun izlenme tahmini güvenilmez olur."
              error={errors.minVideoAgeHours}
              disabled={locked}
              value={bound('minVideoAgeHours')}
              onChange={(v) => set('minVideoAgeHours', v)}
              min={0}
            />
          </div>
        </details>
      </div>

      <div className="shrink-0 border-line border-t p-3">
        {busy ? (
          <>
            <div className="flex gap-2">
              {phase === 'paused' ? (
                <Button
                  variant="primary"
                  className="flex-1"
                  disabled={bekleyenKomut !== null}
                  onClick={() => {
                    setBekleyenKomut('resume');
                    void api.resume();
                  }}
                >
                  {bekleyenKomut === 'resume' ? 'Sürdürülüyor…' : 'Sürdür'}
                </Button>
              ) : (
                <Button
                  className="flex-1"
                  disabled={bekleyenKomut !== null}
                  onClick={() => {
                    setBekleyenKomut('pause');
                    void api.pause();
                  }}
                >
                  {bekleyenKomut === 'pause' ? 'Duraklatılıyor…' : 'Duraklat'}
                </Button>
              )}
              <Button
                variant="danger"
                disabled={bekleyenKomut === 'stop'}
                onClick={() => {
                  setBekleyenKomut('stop');
                  void api.stop();
                }}
              >
                {bekleyenKomut === 'stop' ? 'Durduruluyor…' : 'Durdur'}
              </Button>
            </div>
            {bekleyenKomut !== null && (
              <p className="mt-1.5 text-[11px] text-muted leading-snug">
                Komut alındı. Motor süren isteği bitirdikten sonra duracak — birkaç saniye
                sürebilir.
              </p>
            )}
          </>
        ) : (
          <Button
            variant="primary"
            className="w-full"
            disabled={pending}
            onClick={() => void start()}
          >
            {pending ? 'Başlatılıyor…' : 'Taramayı Başlat'}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Kapatılan filtreleri görünür kılar.
 *
 * Filtre kapatmak sonuçları sessizce değiştiriyor: abone sınırı kapalıyken
 * 2 milyon aboneli bir kanal listede belirdiğinde kullanıcı bunu hata sanabilir.
 * Hangi sınırın kapalı olduğunu söylemek o karışıklığı baştan önlüyor.
 */
const BOUND_LABELS: Record<string, string> = {
  minSubs: 'min abone',
  maxSubs: 'maks abone',
  minViews: 'min izlenme',
  maxViews: 'maks izlenme',
  maxVideoAgeDays: 'maks yaş',
  minVideoAgeHours: 'min yaş',
  minVpd: 'min hız',
};

/**
 * Kanal avının İKİ sorusu: kanal ne kadar yeni, videoları ne kadar izleniyor.
 *
 * Bilinçli olarak ikiye indirildi. Önceden isabet oranı ve ayrı bir "başarı
 * tabanı" da eşikti; ikisi de aynı fikrin farklı yüzleriydi ve üç ayrı sayının
 * birbirini nasıl etkilediğini kestirmek imkânsızdı. İzlenme kararı artık tek
 * yerde — kanalın MEDYANINDA — duruyor. İsabet oranı kartta bilgi olarak
 * kalıyor ama hiçbir şeyi elemiyor, yani ayarlanacak bir şey de değil.
 *
 * Video moduna ait "hype eşiği" de burada gösterilmiyor: kanal modunda hiçbir
 * etkisi yok. Yürüyüş filtreleri (dil, bölge, derinlik) iki modda da geçerli
 * olduğu için yerinde kalıyor.
 */
function ChannelModeFields({
  draft,
  set,
  errors,
  locked,
  num,
}: {
  draft: Record<string, unknown>;
  set: (key: string, value: unknown) => void;
  errors: Record<string, string>;
  locked: boolean;
  num: (key: string) => number;
}) {
  const gun = num('maxChannelAgeDays');
  const ay = Math.round((gun / 30.4) * 10) / 10;
  return (
    <>
      <div className="rounded border border-[var(--color-accent)]/25 bg-[var(--color-accent)]/5 p-2">
        <div className="mb-2 text-[10px] text-muted uppercase tracking-wider">avın iki sorusu</div>
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="Kanal yaşı"
            help="Kanal bundan daha eskiyse aranan 'yeni kanal' değildir. Kuruluş tarihi YouTube'un Hakkında sekmesinden okunuyor — kanalın son videolarının yaşına bakmıyoruz, çünkü sık yükleyen eski bir kanal da tamamen taze videolarla görünür."
            error={errors.maxChannelAgeDays}
          >
            <NumberInput
              disabled={locked}
              min={7}
              max={3650}
              value={gun}
              onChange={(e) => set('maxChannelAgeDays', Number(e.target.value))}
            />
            {/* Gün cinsinden 180 sayısı "ne kadar" hissi vermiyor; ay karşılığı veriyor. */}
            <span className="tnum mt-0.5 block text-[10px] text-muted">gün · ≈ {ay} ay</span>
          </Field>
          <Field
            label="İzlenme eşiği"
            help="Kanalın MEDYAN izlenmesi en az bu kadar olmalı. Medyan, maksimum değil: tek videosu patlamış bir kanal maksimumla geçerdi, medyanla geçemez. Yani 'istikrarlı biçimde çok izleniyor' fikri bu tek sayının içinde duruyor."
            error={errors.minChannelMedianViews}
          >
            <NumberInput
              disabled={locked}
              min={0}
              step={1000}
              value={num('minChannelMedianViews')}
              onChange={(e) => set('minChannelMedianViews', Number(e.target.value))}
            />
            <span className="mt-0.5 block text-[10px] text-muted">videolarının medyanı</span>
          </Field>
        </div>
      </div>

      {/*
        Aşağıdakiler eşik değil, ölçüm zemini: kaç videoya bakılacağı ve tarihi
        okunamayan kanalların ne olacağı. Ayrı durmalarının sebebi bu.
      */}
      <Field
        label="Min video"
        hint="ölçüm zemini"
        help="Kanalın medyanını ölçebilmek için gereken en az yükleme sayısı. İki videosu olan bir kanalın 'medyanı' hakkında konuşmak yanıltıcı olur. Bu bir kalite eşiği değil — istatistiğin anlamlı olma sınırı."
        error={errors.minChannelUploads}
      >
        <NumberInput
          disabled={locked}
          min={2}
          max={30}
          value={num('minChannelUploads')}
          onChange={(e) => set('minChannelUploads', Number(e.target.value))}
        />
      </Field>

      <Toggle
        checked={draft.allowUnknownChannelAge === true}
        onChange={(v) => set('allowUnknownChannelAge', v)}
        label="kuruluş tarihi okunamayan kanalları da kabul et"
      />
    </>
  );
}

function DisabledFilterNotice({ draft }: { draft: Record<string, unknown> }) {
  const off = Object.entries(BOUND_LABELS)
    .filter(([key]) => draft[key] === null)
    .map(([, label]) => label);

  if (off.length === 0) return null;
  return (
    <div className="shrink-0 border-heat-hot/30 border-b bg-heat-hot/10 px-3 py-1.5 text-[11px] text-heat-hot">
      Kapalı filtre: {off.join(', ')} — bu sınırlar uygulanmayacak.
    </div>
  );
}

const PHASE_LABELS: Record<string, { text: string; className: string; pulse?: boolean }> = {
  idle: { text: '○ BOŞTA', className: 'text-muted' },
  stopped: { text: '○ DURDU', className: 'text-muted' },
  seeding: { text: '◌ TOHUMLANIYOR', className: 'text-heat-hot', pulse: true },
  crawling: { text: '● TARANIYOR', className: 'text-accent', pulse: true },
  cooldown: { text: '◔ MOLA', className: 'text-heat-hot' },
  paused: { text: '❙❙ DURAKLATILDI', className: 'text-heat-hot' },
  stopping: { text: '◌ DURDURULUYOR', className: 'text-heat-hot' },
};

function StatusPill({
  phase,
  cooldownUntil,
  detail,
}: {
  phase: string;
  cooldownUntil: number | null;
  detail: string | null;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (cooldownUntil === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [cooldownUntil]);

  const label = PHASE_LABELS[phase] ?? PHASE_LABELS.idle;
  if (label === undefined) return null;

  return (
    <div className="shrink-0 border-line border-b px-3 py-2">
      <div className={cx('flex items-center gap-2 font-semibold text-[12px]', label.className)}>
        <span className={label.pulse === true ? 'pulse' : undefined}>{label.text}</span>
        {cooldownUntil !== null && phase === 'cooldown' && (
          <span className="tnum text-muted">{countdown(cooldownUntil, now)}</span>
        )}
      </div>
      {detail !== null && <p className="mt-0.5 text-[11px] text-muted">{detail}</p>}
    </div>
  );
}
