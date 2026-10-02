// SPDX-License-Identifier: LGPL-3.0-only
import { WriteFailure } from '@socle/view-engine/data-source';

/** Stable codes for the application to distinguish authentication, access and transport failures. @public */
export type RpcErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'invalid'
  | 'not_found'
  | 'csrf'
  | 'rate_limited'
  | 'unavailable'
  | 'invalid_response'
  | 'disposed';

const messages: Readonly<Record<string, Readonly<Record<RpcErrorCode, string>>>> = {
  fr: {
    unauthenticated: 'Votre session a expiré. Reconnectez-vous.',
    forbidden: 'Vous ne disposez pas des droits nécessaires pour cette opération.',
    invalid: 'Les données ne respectent pas les règles du serveur. Vérifiez les valeurs saisies.',
    not_found: 'Cet enregistrement est introuvable ou n’est plus accessible.',
    csrf: 'Votre session a changé. Reconnectez-vous avant de continuer.',
    rate_limited: 'Trop de requêtes. Patientez avant de réessayer.',
    unavailable:
      'Le serveur ne répond pas. Si vous enregistriez des données, vérifiez leur état avant de réessayer.',
    invalid_response:
      'La réponse du serveur est invalide. Vérifiez les données avant de réessayer.',
    disposed: 'Cette connexion est fermée. Rouvrez la fiche pour continuer.',
  },
  en: {
    unauthenticated: 'Your session has expired. Sign in again.',
    forbidden: 'You do not have permission to perform this operation.',
    invalid: 'The server rejected these values. Check the information you entered.',
    not_found: 'This record could not be found or is no longer accessible.',
    csrf: 'Your session has changed. Sign in again before continuing.',
    rate_limited: 'Too many requests. Wait before trying again.',
    unavailable:
      'The server is not responding. If you were saving data, check its state before trying again.',
    invalid_response: 'The server response is invalid. Check the data before trying again.',
    disposed: 'This connection is closed. Reopen the record to continue.',
  },
  ar: {
    unauthenticated: 'انتهت جلستك. سجّل الدخول مجددًا.',
    forbidden: 'ليست لديك الصلاحيات اللازمة لهذه العملية.',
    invalid: 'رفض الخادم هذه القيم. تحقّق من البيانات المدخلة.',
    not_found: 'السجل غير موجود أو لم يعد متاحًا.',
    csrf: 'تغيّرت جلستك. سجّل الدخول مجددًا للمتابعة.',
    rate_limited: 'طلبات كثيرة جدًا. انتظر قبل المحاولة مجددًا.',
    unavailable: 'الخادم لا يستجيب. إذا كنت تحفظ بيانات، تحقّق من حالتها قبل المحاولة مجددًا.',
    invalid_response: 'استجابة الخادم غير صالحة. تحقّق من البيانات قبل المحاولة مجددًا.',
    disposed: 'هذا الاتصال مغلق. أعد فتح السجل للمتابعة.',
  },
};

/**
 * A localized, safe error. Server messages, HTML, payloads and transport errors are never exposed.
 * No field errors are invented: the current RPC protocol does not provide them.
 * @public
 */
export class RpcDataError extends WriteFailure {
  readonly code: RpcErrorCode;
  readonly status: number | undefined;

  constructor(code: RpcErrorCode, language = 'fr', status?: number) {
    const languageKey = language.toLowerCase().split('-')[0] ?? 'fr';
    super(messages[languageKey]?.[code] ?? messages.fr?.[code] ?? code);
    this.name = 'RpcDataError';
    this.code = code;
    this.status = status;
  }
}
