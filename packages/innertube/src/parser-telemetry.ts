import { Parser } from 'youtubei.js';

export interface ParserWarning {
  errorType: string;
  className: string;
}

/**
 * YouTube arayüz değişikliklerinin erken uyarı sistemi.
 *
 * Kütüphane bilmediği bir düğüm sınıfıyla karşılaştığında sessizce atlar.
 * Bu bizim için kritik bir sinyal: "class_not_found" akışı, YouTube'un şema
 * değiştirdiği ve tarama sonuçlarının eksik olabileceği anlamına gelir.
 * Kullanıcıya bir banner olarak gösterilir, sessizce yutulmaz.
 */
export function installParserTelemetry(onWarning: (warning: ParserWarning) => void): void {
  Parser.setParserErrorHandler((error) => {
    const record = error as unknown as Record<string, unknown>;
    const errorType = typeof record.type === 'string' ? record.type : 'unknown';
    const className =
      typeof record.classname === 'string'
        ? record.classname
        : typeof record.class_name === 'string'
          ? record.class_name
          : 'unknown';
    onWarning({ errorType, className });
  });
}
