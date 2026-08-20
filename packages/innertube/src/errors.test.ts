import { GatewayError } from '@hype/core';
import { describe, expect, it } from 'vitest';
import { assertNotBotWalled, assertPlayable, classifyError } from './errors.js';

describe('hata sınıflandırması', () => {
  it('HTTP 429 yumuşak kısıtlamadır', () => {
    expect(classifyError({ status: 429, message: 'Too Many Requests' }).kind).toBe(
      'throttled_soft',
    );
  });

  it('bot duvarı metinleri kimlik sorunudur', () => {
    // InnerTube'un gerçek imzası: temiz bir durum kodu değil, bir cümle.
    expect(classifyError(new Error("Sign in to confirm you're not a bot")).kind).toBe(
      'login_required',
    );
    expect(classifyError(new Error('LOGIN_REQUIRED')).kind).toBe('login_required');
  });

  it('"try again later" sessiz kısıtlama imzasıdır', () => {
    expect(classifyError(new Error("This content isn't available, try again later")).kind).toBe(
      'throttled_soft',
    );
  });

  it('silinmiş ve özel videolar öğe sorunudur, kimlik sorunu değil', () => {
    expect(classifyError(new Error('Video unavailable')).kind).toBe('not_found');
    expect(classifyError(new Error('This video is private')).kind).toBe('not_found');
    expect(classifyError({ status: 404, message: 'Not Found' }).kind).toBe('not_found');
  });

  it('sunucu hataları yeniden denenebilir', () => {
    const error = classifyError({ status: 503, message: 'Service Unavailable' });
    expect(error.kind).toBe('network');
    expect(error.retryable).toBe(true);
  });

  it('ayrıştırma hatası boş-yanıt sinyaline dönüşür', () => {
    expect(classifyError(new Error('ParsingError: unexpected shape')).kind).toBe('parse_empty');
  });

  it('ağ hataları yeniden denenebilir', () => {
    expect(classifyError(new Error('fetch failed: ECONNRESET')).retryable).toBe(true);
  });

  it('zaten sınıflandırılmış hata olduğu gibi geçer', () => {
    const original = new GatewayError('login_required', 'test');
    expect(classifyError(original)).toBe(original);
  });
});

describe('assertPlayable', () => {
  it('LOGIN_REQUIRED bot duvarı olarak fırlatılır', () => {
    expect(() => assertPlayable({ status: 'LOGIN_REQUIRED', reason: 'Sign in' })).toThrow(
      GatewayError,
    );
    try {
      assertPlayable({ status: 'LOGIN_REQUIRED' });
    } catch (error) {
      expect((error as GatewayError).kind).toBe('login_required');
    }
  });

  it('oynatılamayan video öğe sorunudur', () => {
    try {
      assertPlayable({ status: 'UNPLAYABLE', reason: 'removed' });
    } catch (error) {
      expect((error as GatewayError).kind).toBe('not_found');
    }
  });

  it('oynatılamayan video TARAMA yolunda engel değildir', () => {
    // Öneri rafı yine geliyor; o kenarlar graf için tamamen geçerli.
    expect(() => assertNotBotWalled({ status: 'UNPLAYABLE', reason: 'removed' })).not.toThrow();
    expect(() => assertNotBotWalled({ status: 'ERROR' })).not.toThrow();
    // Ama bot duvarı her iki yolda da durdurur.
    expect(() => assertNotBotWalled({ status: 'LOGIN_REQUIRED' })).toThrow(GatewayError);
  });

  it('sağlıklı durum sorunsuz geçer', () => {
    expect(() => assertPlayable({ status: 'OK' })).not.toThrow();
    expect(() => assertPlayable(null)).not.toThrow();
    expect(() => assertPlayable(undefined)).not.toThrow();
  });
});
