(function attachBackgroundPhoneVerification(root, factory) {
  root.MultiPageBackgroundPhoneVerification = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundPhoneVerificationModule() {
  function createPhoneVerificationHelpers(deps = {}) {
    const {
      addLog,
      ensureStep8SignupPageReady,
      fetchImpl = (...args) => fetch(...args),
      getOAuthFlowStepTimeoutMs,
      getState,
      sendToContentScriptResilient,
      setState,
      sleepWithStop,
      throwIfStopped,
      DEFAULT_HERO_SMS_BASE_URL = 'https://hero-sms.com/stubs/handler_api.php',
      DEFAULT_HERO_SMS_REUSE_ENABLED = true,
      HERO_SMS_COUNTRY_ID = 52,
      HERO_SMS_COUNTRY_LABEL = 'Thailand',
      HERO_SMS_SERVICE_CODE = 'dr',
      HERO_SMS_SERVICE_LABEL = 'OpenAI',
      DEFAULT_PHONE_CODE_WAIT_SECONDS = 60,
      DEFAULT_PHONE_CODE_TIMEOUT_WINDOWS = 2,
      DEFAULT_PHONE_CODE_POLL_INTERVAL_SECONDS = 5,
      DEFAULT_PHONE_CODE_POLL_ROUNDS = 4,
    } = deps;

    const PHONE_ACTIVATION_STATE_KEY = 'currentPhoneActivation';
    const PHONE_VERIFICATION_CODE_STATE_KEY = 'currentPhoneVerificationCode';
    const REUSABLE_PHONE_ACTIVATION_STATE_KEY = 'reusablePhoneActivation';
    const HERO_SMS_LAST_PRICE_TIERS_KEY = 'heroSmsLastPriceTiers';
    const HERO_SMS_LAST_PRICE_COUNTRY_ID_KEY = 'heroSmsLastPriceCountryId';
    const HERO_SMS_LAST_PRICE_COUNTRY_LABEL_KEY = 'heroSmsLastPriceCountryLabel';
    const HERO_SMS_LAST_PRICE_USER_LIMIT_KEY = 'heroSmsLastPriceUserLimit';
    const HERO_SMS_LAST_PRICE_AT_KEY = 'heroSmsLastPriceAt';
    const PHONE_CODE_WAIT_SECONDS_MIN = 15;
    const PHONE_CODE_WAIT_SECONDS_MAX = 300;
    const PHONE_CODE_TIMEOUT_WINDOWS_MIN = 1;
    const PHONE_CODE_TIMEOUT_WINDOWS_MAX = 10;
    const PHONE_CODE_POLL_INTERVAL_SECONDS_MIN = 1;
    const PHONE_CODE_POLL_INTERVAL_SECONDS_MAX = 30;
    const PHONE_CODE_POLL_ROUNDS_MIN = 1;
    const PHONE_CODE_POLL_ROUNDS_MAX = 120;
    const DEFAULT_PHONE_POLL_INTERVAL_MS = DEFAULT_PHONE_CODE_POLL_INTERVAL_SECONDS * 1000;
    const DEFAULT_PHONE_POLL_TIMEOUT_MS = 180000;
    const DEFAULT_PHONE_REQUEST_TIMEOUT_MS = 20000;
    const DEFAULT_PHONE_SUBMIT_ATTEMPTS = 3;
    const DEFAULT_PHONE_NUMBER_MAX_USES = 3;
    const DEFAULT_PHONE_NUMBER_REPLACEMENT_LIMIT = 3;
    const DEFAULT_PHONE_PRICE_LOOKUP_ATTEMPTS = 3;
    const MAX_PHONE_PRICE_CANDIDATES = 8;
    const DEFAULT_PHONE_ACTIVATION_RETRY_ROUNDS = 3;
    const PHONE_ACTIVATION_RETRY_ROUNDS_MIN = 1;
    const PHONE_ACTIVATION_RETRY_ROUNDS_MAX = 10;
    const DEFAULT_PHONE_ACTIVATION_RETRY_DELAY_MS = 2000;
    const HERO_SMS_ACQUIRE_PRIORITY_COUNTRY = 'country';
    const HERO_SMS_ACQUIRE_PRIORITY_PRICE = 'price';
    const PHONE_CODE_TIMEOUT_ERROR_PREFIX = 'PHONE_CODE_TIMEOUT::';
    const PHONE_RESTART_STEP7_ERROR_PREFIX = 'PHONE_RESTART_STEP7::';
    const PHONE_RESEND_THROTTLED_ERROR_PREFIX = 'PHONE_RESEND_THROTTLED::';
    const PHONE_SMS_FAILURE_SKIP_THRESHOLD = 2;

    function normalizeUrl(value, fallback = DEFAULT_HERO_SMS_BASE_URL) {
      const trimmed = String(value || '').trim();
      if (!trimmed) {
        return fallback;
      }
      try {
        return new URL(trimmed).toString();
      } catch {
        return fallback;
      }
    }

    function normalizeApiKey(value) {
      return String(value || '').trim();
    }

    function normalizeUseCount(value) {
      return Math.max(0, Math.floor(Number(value) || 0));
    }

    function normalizePhoneReplacementLimit(value) {
      const parsed = Math.floor(Number(value));
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_PHONE_NUMBER_REPLACEMENT_LIMIT;
      }
      return Math.max(1, Math.min(20, parsed));
    }

    function normalizePhoneActivationRetryRounds(value) {
      const parsed = Math.floor(Number(value));
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_PHONE_ACTIVATION_RETRY_ROUNDS;
      }
      return Math.max(PHONE_ACTIVATION_RETRY_ROUNDS_MIN, Math.min(PHONE_ACTIVATION_RETRY_ROUNDS_MAX, parsed));
    }

    function normalizePhoneActivationRetryDelayMs(value) {
      const parsed = Math.floor(Number(value));
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_PHONE_ACTIVATION_RETRY_DELAY_MS;
      }
      return Math.max(500, Math.min(30000, parsed));
    }

    function normalizeHeroSmsPriceLimit(value) {
      if (value === undefined || value === null || String(value).trim() === '') {
        return null;
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
      }
      return Math.round(parsed * 10000) / 10000;
    }

    function isPhoneNumberUsedError(value) {
      const text = String(value || '').trim();
      if (!text) {
        return false;
      }
      return /already\s+linked\s+to\s+the\s+maximum\s+number\s+of\s+accounts|phone\s+number\s+is\s+already\s+(?:in\s+use|linked|registered)|phone\s+number\s+has\s+already\s+been\s+used|already\s+associated\s+with\s+another\s+account|not\s+eligible\s+to\s+be\s+used|cannot\s+be\s+used\s+for\s+verification|号码.*(?:已|被).*(?:使用|占用|绑定|注册)|手机号.*(?:已|被).*(?:使用|占用|绑定|注册)|该手机号.*(?:已|被).*(?:使用|占用|绑定|注册)/i.test(text);
    }

    function normalizeCountryId(value, fallback = HERO_SMS_COUNTRY_ID) {
      const parsed = Math.floor(Number(value));
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
      const fallbackParsed = Math.floor(Number(fallback));
      if (Number.isFinite(fallbackParsed) && fallbackParsed > 0) {
        return fallbackParsed;
      }
      return 0;
    }

    function normalizeCountryLabel(value = '', fallback = HERO_SMS_COUNTRY_LABEL) {
      return String(value || '').trim() || fallback;
    }

    function normalizePhoneCodeWaitSeconds(value) {
      const parsed = Math.floor(Number(value));
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_PHONE_CODE_WAIT_SECONDS;
      }
      return Math.max(PHONE_CODE_WAIT_SECONDS_MIN, Math.min(PHONE_CODE_WAIT_SECONDS_MAX, parsed));
    }

    function normalizePhoneCodeTimeoutWindows(value) {
      const parsed = Math.floor(Number(value));
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_PHONE_CODE_TIMEOUT_WINDOWS;
      }
      return Math.max(PHONE_CODE_TIMEOUT_WINDOWS_MIN, Math.min(PHONE_CODE_TIMEOUT_WINDOWS_MAX, parsed));
    }

    function normalizePhoneCodePollIntervalSeconds(value) {
      const parsed = Math.floor(Number(value));
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_PHONE_CODE_POLL_INTERVAL_SECONDS;
      }
      return Math.max(PHONE_CODE_POLL_INTERVAL_SECONDS_MIN, Math.min(PHONE_CODE_POLL_INTERVAL_SECONDS_MAX, parsed));
    }

    function normalizePhoneCodePollMaxRounds(value) {
      const parsed = Math.floor(Number(value));
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_PHONE_CODE_POLL_ROUNDS;
      }
      return Math.max(PHONE_CODE_POLL_ROUNDS_MIN, Math.min(PHONE_CODE_POLL_ROUNDS_MAX, parsed));
    }

    function normalizeHeroSmsReuseEnabled(value) {
      if (value === undefined || value === null) {
        return Boolean(DEFAULT_HERO_SMS_REUSE_ENABLED);
      }
      return Boolean(value);
    }

    function normalizeHeroSmsAcquirePriority(value = '') {
      return String(value || '').trim().toLowerCase() === HERO_SMS_ACQUIRE_PRIORITY_PRICE
        ? HERO_SMS_ACQUIRE_PRIORITY_PRICE
        : HERO_SMS_ACQUIRE_PRIORITY_COUNTRY;
    }

    function normalizeCountryFallbackList(value = []) {
      const source = Array.isArray(value)
        ? value
        : String(value || '')
          .split(/[\r\n,，;；]+/)
          .map((entry) => String(entry || '').trim())
          .filter(Boolean);
      const seen = new Set();
      const normalized = [];

      for (const entry of source) {
        let id = 0;
        let label = '';

        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          id = normalizeCountryId(entry.id ?? entry.countryId, 0);
          label = String((entry.label ?? entry.countryLabel) || '').trim();
        } else {
          const text = String(entry || '').trim();
          const structured = text.match(/^(\d+)\s*(?:[:|/-]\s*(.+))?$/);
          if (structured) {
            id = normalizeCountryId(structured[1], 0);
            label = String(structured[2] || '').trim();
          } else {
            id = normalizeCountryId(text, 0);
          }
        }

        if (!Number.isFinite(id) || id <= 0 || seen.has(id)) {
          continue;
        }
        seen.add(id);
        normalized.push({
          id,
          label: label || `Country #${id}`,
        });
      }

      return normalized;
    }

    function resolveCountryConfig(state = {}) {
      return {
        id: normalizeCountryId(state.heroSmsCountryId, HERO_SMS_COUNTRY_ID),
        label: normalizeCountryLabel(state.heroSmsCountryLabel, HERO_SMS_COUNTRY_LABEL),
      };
    }

    function resolveCountryCandidates(state = {}) {
      const primary = resolveCountryConfig(state);
      const fallbackList = normalizeCountryFallbackList(state.heroSmsCountryFallback);
      const seen = new Set([primary.id]);
      const candidates = [primary];

      fallbackList.forEach((entry) => {
        const nextId = normalizeCountryId(entry.id, 0);
        if (!Number.isFinite(nextId) || nextId <= 0 || seen.has(nextId)) {
          return;
        }
        seen.add(nextId);
        candidates.push({
          id: nextId,
          label: normalizeCountryLabel(entry.label, `Country #${nextId}`),
        });
      });

      return candidates;
    }

    function normalizeActivation(record) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return null;
      }
      const activationId = String(
        record.activationId ?? record.id ?? record.activation ?? ''
      ).trim();
      const phoneNumber = String(
        record.phoneNumber ?? record.number ?? record.phone ?? ''
      ).trim();
      if (!activationId || !phoneNumber) {
        return null;
      }
      const statusAction = String(record.statusAction || '').trim();
      const countryLabel = String(record.countryLabel || '').trim();
      return {
        activationId,
        phoneNumber,
        provider: String(record.provider || 'hero-sms').trim() || 'hero-sms',
        serviceCode: String(record.serviceCode || HERO_SMS_SERVICE_CODE).trim() || HERO_SMS_SERVICE_CODE,
        countryId: normalizeCountryId(record.countryId, HERO_SMS_COUNTRY_ID),
        ...(countryLabel ? { countryLabel } : {}),
        successfulUses: normalizeUseCount(record.successfulUses),
        maxUses: Math.max(1, Math.floor(Number(record.maxUses) || DEFAULT_PHONE_NUMBER_MAX_USES)),
        ...(statusAction ? { statusAction } : {}),
      };
    }

    function normalizeActivationFallback(record) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return null;
      }

      const fallback = {};
      const provider = String(record.provider || '').trim();
      const serviceCode = String(record.serviceCode || '').trim();
      const countryId = Math.floor(Number(record.countryId));
      const countryLabel = String(record.countryLabel || '').trim();
      const statusAction = String(record.statusAction || '').trim();

      if (provider) {
        fallback.provider = provider;
      }
      if (serviceCode) {
        fallback.serviceCode = serviceCode;
      }
      if (Number.isFinite(countryId) && countryId > 0) {
        fallback.countryId = countryId;
      }
      if (countryLabel) {
        fallback.countryLabel = countryLabel;
      }
      if (Object.prototype.hasOwnProperty.call(record, 'successfulUses')) {
        fallback.successfulUses = normalizeUseCount(record.successfulUses);
      }
      if (Object.prototype.hasOwnProperty.call(record, 'maxUses')) {
        fallback.maxUses = Math.max(1, Math.floor(Number(record.maxUses) || DEFAULT_PHONE_NUMBER_MAX_USES));
      }
      if (statusAction) {
        fallback.statusAction = statusAction;
      }

      return Object.keys(fallback).length ? fallback : null;
    }

    function describeHeroSmsPayload(raw) {
      if (typeof raw === 'string') {
        return raw.trim();
      }
      if (raw && typeof raw === 'object') {
        if (raw.title || raw.details) {
          const title = String(raw.title || '').trim();
          const details = String(raw.details || '').trim();
          return details ? `${title}: ${details}` : title;
        }
        if (raw.status === 'false' && raw.msg) {
          return String(raw.msg).trim();
        }
        try {
          return JSON.stringify(raw);
        } catch {
          return String(raw);
        }
      }
      return String(raw || '').trim();
    }

    function parseHeroSmsPayload(text) {
      const trimmed = String(text || '').trim();
      if (!trimmed) {
        return '';
      }
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          return JSON.parse(trimmed);
        } catch {
          return trimmed;
        }
      }
      return trimmed;
    }

    function buildHeroSmsUrl(baseUrl, query = {}) {
      const url = new URL(normalizeUrl(baseUrl));
      Object.entries(query).forEach(([key, value]) => {
        if (value === undefined || value === null || value === '') {
          return;
        }
        url.searchParams.set(key, String(value));
      });
      return url.toString();
    }

    function buildPhoneCodeTimeoutError(lastResponse = '') {
      const suffix = lastResponse ? ` Last HeroSMS status: ${lastResponse}` : '';
      return new Error(`${PHONE_CODE_TIMEOUT_ERROR_PREFIX}Timed out waiting for the phone verification code.${suffix}`);
    }

    function isPhoneCodeTimeoutError(error) {
      return String(error?.message || '').startsWith(PHONE_CODE_TIMEOUT_ERROR_PREFIX);
    }

    function isPhoneResendThrottledError(error) {
      const message = String(error?.message || error || '').trim();
      if (!message) {
        return false;
      }
      if (message.startsWith(PHONE_RESEND_THROTTLED_ERROR_PREFIX)) {
        return true;
      }
      return /tried\s+to\s+resend\s+too\s+many\s+times|please\s+try\s+again\s+later|too\s+many\s+resend|resend\s+too\s+many|发送.*过于频繁|稍后再试/i.test(message);
    }

    function buildPhoneRestartStep7Error(phoneNumber = '') {
      const suffix = phoneNumber ? ` Current number: ${phoneNumber}.` : '';
      return new Error(
        `${PHONE_RESTART_STEP7_ERROR_PREFIX}Phone verification could not receive an SMS after resend. Restart step 7 with a new number.${suffix}`
      );
    }

    function sanitizePhoneCodeTimeoutError(error) {
      const message = String(error?.message || '');
      if (!message.startsWith(PHONE_CODE_TIMEOUT_ERROR_PREFIX)) {
        return error;
      }
      return new Error(message.slice(PHONE_CODE_TIMEOUT_ERROR_PREFIX.length).trim() || 'Timed out waiting for the phone verification code.');
    }

    function sanitizePhoneRestartStep7Error(error) {
      const message = String(error?.message || '');
      if (!message.startsWith(PHONE_RESTART_STEP7_ERROR_PREFIX)) {
        return error;
      }
      return new Error(
        message.slice(PHONE_RESTART_STEP7_ERROR_PREFIX.length).trim()
        || 'Phone verification could not receive an SMS after resend. Restart step 7 with a new number.'
      );
    }

    async function fetchHeroSmsPayload(config, query, actionLabel) {
      const requestUrl = buildHeroSmsUrl(config.baseUrl, {
        api_key: config.apiKey,
        ...query,
      });
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timeoutId = controller
        ? setTimeout(() => controller.abort(), DEFAULT_PHONE_REQUEST_TIMEOUT_MS)
        : null;

      try {
        const response = await fetchImpl(requestUrl, {
          method: 'GET',
          signal: controller?.signal,
        });
        const text = await response.text();
        const payload = parseHeroSmsPayload(text);
        if (!response.ok) {
          const requestError = new Error(`${actionLabel} failed: ${describeHeroSmsPayload(payload) || response.status}`);
          requestError.payload = payload;
          requestError.status = response.status;
          throw requestError;
        }
        return payload;
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw new Error(`${actionLabel} timed out.`);
        }
        throw error;
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
    }

    function resolvePhoneConfig(state = {}) {
      const apiKey = normalizeApiKey(state.heroSmsApiKey);
      if (!apiKey) {
        throw new Error('HeroSMS API key is missing. Save it in the side panel before running the phone flow.');
      }
      return {
        apiKey,
        baseUrl: normalizeUrl(state.heroSmsBaseUrl, DEFAULT_HERO_SMS_BASE_URL),
      };
    }

    function parseActivationPayload(payload, fallback = null) {
      const normalizedFallback = normalizeActivation(fallback) || normalizeActivationFallback(fallback);
      const directActivation = normalizeActivation(payload);
      if (directActivation) {
        const statusAction = normalizedFallback?.statusAction || directActivation.statusAction;
          return {
            ...directActivation,
            provider: normalizedFallback?.provider || directActivation.provider,
            serviceCode: normalizedFallback?.serviceCode || directActivation.serviceCode,
            countryId: normalizedFallback?.countryId || directActivation.countryId,
            ...(
              normalizedFallback?.countryLabel || directActivation.countryLabel
                ? { countryLabel: normalizedFallback?.countryLabel || directActivation.countryLabel }
                : {}
            ),
            successfulUses: normalizedFallback?.successfulUses ?? directActivation.successfulUses,
            maxUses: normalizedFallback?.maxUses ?? directActivation.maxUses,
            ...(statusAction ? { statusAction } : {}),
          };
        }

      const text = describeHeroSmsPayload(payload);
      const accessNumberMatch = text.match(/^ACCESS_NUMBER:([^:]+):(.+)$/i);
      if (accessNumberMatch) {
          return {
            activationId: String(accessNumberMatch[1] || '').trim(),
            phoneNumber: String(accessNumberMatch[2] || '').trim(),
            provider: normalizedFallback?.provider || 'hero-sms',
            serviceCode: normalizedFallback?.serviceCode || HERO_SMS_SERVICE_CODE,
            countryId: normalizedFallback?.countryId || HERO_SMS_COUNTRY_ID,
            ...(normalizedFallback?.countryLabel ? { countryLabel: normalizedFallback.countryLabel } : {}),
            successfulUses: normalizedFallback?.successfulUses ?? 0,
            maxUses: normalizedFallback?.maxUses ?? DEFAULT_PHONE_NUMBER_MAX_USES,
            ...(normalizedFallback?.statusAction ? { statusAction: normalizedFallback.statusAction } : {}),
          };
        }

      if (/^ACCESS_READY$/i.test(text) && normalizedFallback) {
        return normalizedFallback;
      }

      return null;
    }

    function resolveActivationStatusAction(activation) {
      return activation?.statusAction === 'getStatusV2' ? 'getStatusV2' : 'getStatus';
    }

    function normalizeHeroSmsPrice(value) {
      const price = Number(value);
      if (!Number.isFinite(price) || price < 0) {
        return null;
      }
      return price;
    }

    function collectHeroSmsPriceCandidates(payload, candidates = []) {
      if (Array.isArray(payload)) {
        payload.forEach((entry) => collectHeroSmsPriceCandidates(entry, candidates));
        return candidates;
      }
      if (!payload || typeof payload !== 'object') {
        return candidates;
      }

      const cost = normalizeHeroSmsPrice(payload.cost);
      if (cost !== null) {
        const count = Number(payload.count);
        const physicalCount = Number(payload.physicalCount);
        const hasCount = Number.isFinite(count);
        const hasPhysicalCount = Number.isFinite(physicalCount);
        if ((!hasCount && !hasPhysicalCount) || count > 0 || physicalCount > 0) {
          candidates.push(cost);
        }
      }

      Object.values(payload).forEach((value) => collectHeroSmsPriceCandidates(value, candidates));
      return candidates;
    }

    function findLowestHeroSmsPrice(payload) {
      const candidates = collectHeroSmsPriceCandidates(payload, []);
      if (!candidates.length) {
        return null;
      }
      return Math.min(...candidates);
    }

    function buildSortedUniquePriceCandidates(values = []) {
      return Array.from(
        new Set(
          values
            .map((value) => normalizeHeroSmsPrice(value))
            .filter((value) => value !== null)
            .map((value) => Math.round(value * 10000) / 10000)
        )
      )
        .sort((left, right) => left - right)
        .slice(0, MAX_PHONE_PRICE_CANDIDATES);
    }

    function isHeroSmsNoNumbersPayload(payload) {
      return /\bNO_NUMBERS\b/i.test(describeHeroSmsPayload(payload));
    }

    function extractHeroSmsWrongMaxPrice(payload) {
      if (payload && typeof payload === 'object') {
        const title = String(payload.title || '').trim();
        const minPrice = normalizeHeroSmsPrice(payload.info?.min);
        if (/^WRONG_MAX_PRICE$/i.test(title) && minPrice !== null) {
          return minPrice;
        }
      }

      const text = describeHeroSmsPayload(payload);
      const match = text.match(/\bWRONG_MAX_PRICE:(\d+(?:\.\d+)?)\b/i);
      if (!match) {
        return null;
      }
      return normalizeHeroSmsPrice(match[1]);
    }

    function isNetworkFetchFailure(error) {
      const message = String(error?.message || '').trim();
      return /failed to fetch|networkerror|load failed/i.test(message);
    }

    function isHeroSmsTerminalError(payloadOrMessage) {
      const text = describeHeroSmsPayload(payloadOrMessage);
      return /\bNO_BALANCE\b|\bNOT_ENOUGH_BALANCE\b|\bBAD_KEY\b|\bINVALID_KEY\b|\bBANNED\b|\bACCOUNT_BANNED\b|\bWRONG_KEY\b/i.test(text);
    }

    async function resolveCheapestPhoneActivationPrice(config, countryConfig) {
      for (let attempt = 1; attempt <= DEFAULT_PHONE_PRICE_LOOKUP_ATTEMPTS; attempt += 1) {
        try {
          const payload = await fetchHeroSmsPayload(config, {
            action: 'getPrices',
            service: HERO_SMS_SERVICE_CODE,
            country: countryConfig.id,
          }, 'HeroSMS getPrices');
          const price = findLowestHeroSmsPrice(payload);
          if (price !== null) {
            return price;
          }
        } catch (_) {
          // Best-effort lookup only.
        }
      }
      return null;
    }

    async function persistHeroSmsPricePlanSnapshot(countryConfig, pricePlan) {
      if (typeof setState !== 'function') {
        return;
      }
      const prices = Array.isArray(pricePlan?.prices)
        ? pricePlan.prices.filter((price) => Number.isFinite(Number(price)))
        : [];
      const userLimit = pricePlan?.userLimit === null || pricePlan?.userLimit === undefined
        ? ''
        : String(pricePlan.userLimit);
      await setState({
        [HERO_SMS_LAST_PRICE_TIERS_KEY]: prices,
        [HERO_SMS_LAST_PRICE_COUNTRY_ID_KEY]: normalizeCountryId(countryConfig?.id, 0),
        [HERO_SMS_LAST_PRICE_COUNTRY_LABEL_KEY]: normalizeCountryLabel(countryConfig?.label, HERO_SMS_COUNTRY_LABEL),
        [HERO_SMS_LAST_PRICE_USER_LIMIT_KEY]: userLimit,
        [HERO_SMS_LAST_PRICE_AT_KEY]: Date.now(),
      });
    }

    async function resolvePhoneActivationPricePlan(config, countryConfig, state = {}) {
      const userLimit = normalizeHeroSmsPriceLimit(state.heroSmsMaxPrice);
      let priceCandidates = [];

      for (let attempt = 1; attempt <= DEFAULT_PHONE_PRICE_LOOKUP_ATTEMPTS; attempt += 1) {
        try {
          const payload = await fetchHeroSmsPayload(config, {
            action: 'getPrices',
            service: HERO_SMS_SERVICE_CODE,
            country: countryConfig.id,
          }, 'HeroSMS getPrices');
          priceCandidates = buildSortedUniquePriceCandidates(
            collectHeroSmsPriceCandidates(payload, [])
          );
          if (priceCandidates.length > 0) {
            break;
          }
        } catch (_) {
          // best effort
        }
      }

      const minCatalogPrice = priceCandidates.length > 0 ? priceCandidates[0] : null;
      if (userLimit !== null) {
        const bounded = priceCandidates.filter((price) => price <= userLimit);
        if (bounded.length > 0) {
          const boundedPlan = { prices: bounded, userLimit, minCatalogPrice };
          await persistHeroSmsPricePlanSnapshot(countryConfig, boundedPlan);
          return boundedPlan;
        }
        const userLimitedPlan = { prices: [userLimit], userLimit, minCatalogPrice };
        await persistHeroSmsPricePlanSnapshot(countryConfig, userLimitedPlan);
        return userLimitedPlan;
      }

      if (priceCandidates.length > 0) {
        const plan = { prices: priceCandidates, userLimit: null, minCatalogPrice };
        await persistHeroSmsPricePlanSnapshot(countryConfig, plan);
        return plan;
      }
      const fallbackPlan = { prices: [null], userLimit: null, minCatalogPrice: null };
      await persistHeroSmsPricePlanSnapshot(countryConfig, fallbackPlan);
      return fallbackPlan;
    }

    async function fetchPhoneActivationPayload(config, countryConfig, action, options = {}) {
      const query = {
        action,
        service: HERO_SMS_SERVICE_CODE,
        country: countryConfig.id,
      };
      if (options.maxPrice !== null && options.maxPrice !== undefined) {
        query.maxPrice = options.maxPrice;
        query.fixedPrice = 'true';
      }
      return fetchHeroSmsPayload(config, query, `HeroSMS ${action}`);
    }

    async function requestPhoneActivationWithPrice(config, countryConfig, action, maxPrice, options = {}) {
      let nextMaxPrice = maxPrice;
      let retriedWithUpdatedPrice = false;
      let retriedWithoutPrice = false;
      const userLimit = normalizeHeroSmsPriceLimit(options.userLimit);

      while (true) {
        try {
          return await fetchPhoneActivationPayload(config, countryConfig, action, {
            maxPrice: nextMaxPrice,
          });
        } catch (error) {
          const updatedMaxPrice = extractHeroSmsWrongMaxPrice(error?.payload || error?.message);
          if (
            nextMaxPrice !== null
            && nextMaxPrice !== undefined
            && !retriedWithUpdatedPrice
            && updatedMaxPrice !== null
          ) {
            if (userLimit !== null && updatedMaxPrice > userLimit) {
              throw new Error(
                `HeroSMS ${action} failed: WRONG_MAX_PRICE requires ${updatedMaxPrice}, which exceeds configured maxPrice=${userLimit}.`
              );
            }
            nextMaxPrice = updatedMaxPrice;
            retriedWithUpdatedPrice = true;
            continue;
          }

          if (
            nextMaxPrice !== null
            && nextMaxPrice !== undefined
            && !retriedWithoutPrice
            && isNetworkFetchFailure(error)
          ) {
            nextMaxPrice = null;
            retriedWithoutPrice = true;
            continue;
          }

          throw error;
        }
      }
    }

    async function requestPhoneActivation(state = {}, options = {}) {
      const config = resolvePhoneConfig(state);
      const allCountryCandidates = resolveCountryCandidates(state);
      const blockedCountryIds = new Set(
        (Array.isArray(options?.blockedCountryIds) ? options.blockedCountryIds : [])
          .map((value) => normalizeCountryId(value, 0))
          .filter((id) => id > 0)
      );
      let countryCandidates = allCountryCandidates.filter(
        (entry) => !blockedCountryIds.has(normalizeCountryId(entry.id, 0))
      );
      if (!countryCandidates.length) {
        countryCandidates = allCountryCandidates;
        if (blockedCountryIds.size) {
          await addLog(
            'Step 9: all selected countries reached the temporary SMS-failure skip threshold, lifting skip for this acquire round.',
            'warn'
          );
        }
      }
      const acquirePriority = normalizeHeroSmsAcquirePriority(state?.heroSmsAcquirePriority);
      const requestActions = ['getNumber', 'getNumberV2'];
      const configuredAcquireRounds = normalizePhoneActivationRetryRounds(
        state?.heroSmsActivationRetryRounds
      );
      const maxAcquireRounds = Math.max(2, configuredAcquireRounds);
      const retryDelayMs = normalizePhoneActivationRetryDelayMs(
        state?.heroSmsActivationRetryDelayMs
      );

      let finalNoNumbersByCountry = [];
      let finalLastError = null;
      let finalLastFailureText = '';

      for (let round = 1; round <= maxAcquireRounds; round += 1) {
        if (maxAcquireRounds > 1) {
          await addLog(
            `Step 9: HeroSMS acquiring phone number (round ${round}/${maxAcquireRounds})...`,
            'info'
          );
        }

        const countryAttempts = countryCandidates.map((countryConfig, index) => ({
          index,
          countryConfig,
          pricePlan: null,
          orderingPrice: Number.POSITIVE_INFINITY,
        }));

        if (acquirePriority === HERO_SMS_ACQUIRE_PRIORITY_PRICE) {
          for (const attempt of countryAttempts) {
            const pricePlan = await resolvePhoneActivationPricePlan(config, attempt.countryConfig, state);
            const numericPrices = Array.isArray(pricePlan?.prices)
              ? pricePlan.prices
                  .map((value) => Number(value))
                  .filter((value) => Number.isFinite(value) && value >= 0)
              : [];
            const minCandidatePrice = numericPrices.length ? Math.min(...numericPrices) : null;
            const cappedByUserLimit = (
              pricePlan?.userLimit !== null
              && pricePlan?.userLimit !== undefined
              && pricePlan?.minCatalogPrice !== null
              && pricePlan?.minCatalogPrice !== undefined
              && Number(pricePlan.minCatalogPrice) > Number(pricePlan.userLimit)
            );
            attempt.pricePlan = pricePlan;
            attempt.orderingPrice = cappedByUserLimit
              ? Number.POSITIVE_INFINITY
              : (minCandidatePrice !== null ? minCandidatePrice : Number.POSITIVE_INFINITY);
          }
        }

        if (acquirePriority === HERO_SMS_ACQUIRE_PRIORITY_PRICE && countryAttempts.length > 1) {
          countryAttempts.sort((left, right) => {
            if (left.orderingPrice !== right.orderingPrice) {
              return left.orderingPrice - right.orderingPrice;
            }
            return left.index - right.index;
          });
        }

        const noNumbersByCountry = [];
        const retryableNoNumberCountries = [];
        let lastError = null;
        let lastFailureText = '';

        for (const attempt of countryAttempts) {
          const countryConfig = attempt.countryConfig;
          const buildFallbackActivation = (requestAction) => ({
            countryId: countryConfig.id,
            ...(requestAction === 'getNumberV2' ? { statusAction: 'getStatusV2' } : {}),
          });
          const pricePlan = attempt.pricePlan || await resolvePhoneActivationPricePlan(config, countryConfig, state);
          let noNumbersObservedInCountry = false;

          for (const maxPrice of pricePlan.prices) {
            for (const requestAction of requestActions) {
              try {
                const payload = await requestPhoneActivationWithPrice(
                  config,
                  countryConfig,
                  requestAction,
                  maxPrice,
                  { userLimit: pricePlan.userLimit }
                );
                const activation = parseActivationPayload(payload, buildFallbackActivation(requestAction));
                if (activation) {
                  const { countryLabel: _ignoredCountryLabel, ...activationWithoutCountryLabel } = activation;
                  return {
                    ...activationWithoutCountryLabel,
                    countryId: countryConfig.id,
                  };
                }
                const payloadText = describeHeroSmsPayload(payload);
                if (isHeroSmsNoNumbersPayload(payload)) {
                  noNumbersObservedInCountry = true;
                  lastFailureText = payloadText || lastFailureText;
                  continue;
                }
                if (isHeroSmsTerminalError(payload)) {
                  throw new Error(`HeroSMS ${requestAction} failed: ${payloadText || 'empty response'}`);
                }
                lastFailureText = payloadText || lastFailureText;
                lastError = new Error(`HeroSMS ${requestAction} failed: ${payloadText || 'empty response'}`);
              } catch (error) {
                const payloadOrMessage = error?.payload || error?.message;
                if (isHeroSmsTerminalError(payloadOrMessage)) {
                  throw new Error(`HeroSMS ${requestAction} failed: ${describeHeroSmsPayload(payloadOrMessage) || 'empty response'}`);
                }
                if (isHeroSmsNoNumbersPayload(payloadOrMessage)) {
                  noNumbersObservedInCountry = true;
                  lastFailureText = describeHeroSmsPayload(payloadOrMessage) || lastFailureText;
                  continue;
                }
                lastFailureText = describeHeroSmsPayload(payloadOrMessage) || lastFailureText;
                lastError = error;
              }
            }
          }

          if (noNumbersObservedInCountry) {
            if (
              pricePlan.userLimit !== null
              && pricePlan.minCatalogPrice !== null
              && pricePlan.minCatalogPrice > pricePlan.userLimit
            ) {
              noNumbersByCountry.push(
                `${countryConfig.label}: no numbers within maxPrice=${pricePlan.userLimit}; lowest listed=${pricePlan.minCatalogPrice}`
              );
            } else {
              noNumbersByCountry.push(
                `${countryConfig.label}: ${lastFailureText || 'NO_NUMBERS'}`
              );
              retryableNoNumberCountries.push(countryConfig.label);
            }
            continue;
          }
        }

        finalNoNumbersByCountry = noNumbersByCountry;
        finalLastError = lastError;
        finalLastFailureText = lastFailureText;

        if (
          noNumbersByCountry.length
          && round < maxAcquireRounds
          && retryableNoNumberCountries.length > 0
        ) {
          await addLog(
            `Step 9: HeroSMS has no available numbers (round ${round}/${maxAcquireRounds}); retrying in ${Math.ceil(retryDelayMs / 1000)}s. Countries: ${retryableNoNumberCountries.join(', ')}.`,
            'warn'
          );
          await sleepWithStop(retryDelayMs);
          continue;
        }

        break;
      }

      if (finalNoNumbersByCountry.length) {
        throw new Error(
          `HeroSMS no numbers available across ${countryCandidates.length} country candidate(s): ${finalNoNumbersByCountry.join(' | ')}.`
        );
      }
      if (finalLastError) {
        throw finalLastError;
      }
      throw new Error(`HeroSMS failed to acquire a phone number. Last status: ${finalLastFailureText || 'unknown'}.`);
    }

    async function reactivatePhoneActivation(state = {}, activation) {
      const normalizedActivation = normalizeActivation(activation);
      if (!normalizedActivation) {
        throw new Error('Reusable phone activation is missing.');
      }

      const config = resolvePhoneConfig(state);
      const payload = await fetchHeroSmsPayload(config, {
        action: 'reactivate',
        id: normalizedActivation.activationId,
      }, 'HeroSMS reactivate');
      const nextActivation = parseActivationPayload(payload, normalizedActivation);
      if (!nextActivation) {
        const text = describeHeroSmsPayload(payload);
        throw new Error(`HeroSMS reactivate failed: ${text || 'empty response'}`);
      }
      return nextActivation;
    }

    async function setPhoneActivationStatus(state = {}, activation, status, actionLabel) {
      const normalizedActivation = normalizeActivation(activation);
      if (!normalizedActivation) {
        return '';
      }
      const config = resolvePhoneConfig(state);
      const payload = await fetchHeroSmsPayload(config, {
        action: 'setStatus',
        id: normalizedActivation.activationId,
        status,
      }, actionLabel);
      return describeHeroSmsPayload(payload);
    }

    async function completePhoneActivation(state = {}, activation) {
      await setPhoneActivationStatus(state, activation, 6, 'HeroSMS setStatus(6)');
    }

    async function cancelPhoneActivation(state = {}, activation) {
      try {
        await setPhoneActivationStatus(state, activation, 8, 'HeroSMS setStatus(8)');
      } catch (_) {
        // Best-effort cleanup.
      }
    }

    async function requestAdditionalPhoneSms(state = {}, activation) {
      try {
        await setPhoneActivationStatus(state, activation, 3, 'HeroSMS setStatus(3)');
      } catch (_) {
        // Best-effort request only.
      }
    }

    async function pollPhoneActivationCode(state = {}, activation, options = {}) {
      const normalizedActivation = normalizeActivation(activation);
      if (!normalizedActivation) {
        throw new Error('Phone activation is missing.');
      }
      const statusAction = resolveActivationStatusAction(normalizedActivation);

      const config = resolvePhoneConfig(state);
      const configuredTimeoutMs = Math.max(1000, Number(options.timeoutMs) || 0);
      const timeoutMs = configuredTimeoutMs || (
        typeof getOAuthFlowStepTimeoutMs === 'function'
          ? await getOAuthFlowStepTimeoutMs(
            DEFAULT_PHONE_POLL_TIMEOUT_MS,
            { step: 9, actionLabel: options.actionLabel || 'poll phone verification code' }
          )
          : DEFAULT_PHONE_POLL_TIMEOUT_MS
      );
      const intervalMs = Math.max(1000, Number(options.intervalMs) || DEFAULT_PHONE_POLL_INTERVAL_MS);
      const maxRoundsRaw = Math.floor(Number(options.maxRounds));
      const maxRounds = Number.isFinite(maxRoundsRaw) && maxRoundsRaw > 0 ? maxRoundsRaw : 0;
      const start = Date.now();
      let lastResponse = '';
      let pollCount = 0;

      while (Date.now() - start < timeoutMs) {
        if (maxRounds > 0 && pollCount >= maxRounds) {
          break;
        }
        throwIfStopped();
        const payload = await fetchHeroSmsPayload(config, {
          action: statusAction,
          id: normalizedActivation.activationId,
        }, `HeroSMS ${statusAction}`);
        const text = describeHeroSmsPayload(payload);
        lastResponse = text;
        pollCount += 1;

        if (typeof options.onStatus === 'function') {
          await options.onStatus({
            activation: normalizedActivation,
            elapsedMs: Date.now() - start,
            pollCount,
            statusText: text,
            timeoutMs,
          });
        }

        const extractVerificationCode = (rawCode) => {
          const trimmed = String(rawCode || '').trim();
          if (!trimmed) {
            return '';
          }
          const digitMatch = trimmed.match(/\b(\d{4,8})\b/);
          return digitMatch?.[1] || trimmed;
        };

        const v2Code = (
          payload
          && typeof payload === 'object'
          && !Array.isArray(payload)
          && (
            extractVerificationCode(payload.sms?.code)
            || extractVerificationCode(payload.call?.code)
          )
        );
        if (v2Code) {
          return v2Code;
        }

        const okMatch = text.match(/^STATUS_OK:(.+)$/i);
        if (okMatch) {
          const rawCode = String(okMatch[1] || '').trim();
          const digitMatch = rawCode.match(/\b(\d{4,8})\b/);
          return digitMatch?.[1] || rawCode;
        }

        if (/^STATUS_(WAIT_CODE|WAIT_RETRY|WAIT_RESEND)$/i.test(text)) {
          await sleepWithStop(intervalMs);
          continue;
        }

        if (statusAction === 'getStatusV2' && payload && typeof payload === 'object' && !Array.isArray(payload)) {
          await sleepWithStop(intervalMs);
          continue;
        }

        if (/^STATUS_CANCEL$/i.test(text)) {
          throw new Error('HeroSMS activation was cancelled before the SMS arrived.');
        }

        throw new Error(`HeroSMS ${statusAction} failed: ${text || 'empty response'}`);
      }

      throw buildPhoneCodeTimeoutError(lastResponse);
    }

    async function readPhonePageState(tabId, timeoutMs = 10000) {
      await ensureStep8SignupPageReady(tabId, {
        timeoutMs,
        logMessage: 'Step 9: waiting for auth page content script to recover before phone verification.',
      });
      const result = await sendToContentScriptResilient('signup-page', {
        type: 'STEP8_GET_STATE',
        source: 'background',
        payload: {},
      }, {
        timeoutMs,
        responseTimeoutMs: timeoutMs,
        retryDelayMs: 600,
        logMessage: 'Step 9: auth page is switching, waiting to inspect phone verification state again...',
      });

      if (result?.error) {
        throw new Error(result.error);
      }
      return result || {};
    }

    function resolveCountryConfigFromActivation(activation, fallbackState = {}) {
      const candidates = resolveCountryCandidates(fallbackState);
      if (activation && typeof activation === 'object') {
        const countryId = normalizeCountryId(activation.countryId, 0);
        if (countryId > 0) {
          const matched = candidates.find((entry) => entry.id === countryId);
          if (matched) {
            return matched;
          }
          return {
            id: countryId,
            label: normalizeCountryLabel(activation.countryLabel, `Country #${countryId}`),
          };
        }
      }
      return candidates[0] || resolveCountryConfig(fallbackState);
    }

    async function submitPhoneNumber(tabId, phoneNumber, activation = null) {
      const state = await getState();
      const countryConfig = resolveCountryConfigFromActivation(activation, state);
      const timeoutMs = typeof getOAuthFlowStepTimeoutMs === 'function'
        ? await getOAuthFlowStepTimeoutMs(30000, { step: 9, actionLabel: 'submit add-phone number' })
        : 30000;
      const result = await sendToContentScriptResilient('signup-page', {
        type: 'SUBMIT_PHONE_NUMBER',
        source: 'background',
        payload: {
          phoneNumber,
          countryId: countryConfig.id,
          countryLabel: countryConfig.label,
        },
      }, {
        timeoutMs,
        responseTimeoutMs: timeoutMs,
        retryDelayMs: 600,
        logMessage: 'Step 9: waiting for add-phone page to become ready...',
      });

      if (result?.error) {
        throw new Error(result.error);
      }
      return result || {};
    }

    async function submitPhoneVerificationCode(tabId, code) {
      const timeoutMs = typeof getOAuthFlowStepTimeoutMs === 'function'
        ? await getOAuthFlowStepTimeoutMs(45000, { step: 9, actionLabel: 'submit phone verification code' })
        : 45000;
      const result = await sendToContentScriptResilient('signup-page', {
        type: 'SUBMIT_PHONE_VERIFICATION_CODE',
        source: 'background',
        payload: { code },
      }, {
        timeoutMs,
        responseTimeoutMs: timeoutMs,
        retryDelayMs: 600,
        logMessage: 'Step 9: waiting for phone verification page before filling the SMS code...',
      });

      if (result?.error) {
        throw new Error(result.error);
      }
      return result || {};
    }

    async function resendPhoneVerificationCode(tabId) {
      const timeoutMs = typeof getOAuthFlowStepTimeoutMs === 'function'
        ? await getOAuthFlowStepTimeoutMs(30000, { step: 9, actionLabel: 'resend phone verification code' })
        : 30000;
      const result = await sendToContentScriptResilient('signup-page', {
        type: 'RESEND_PHONE_VERIFICATION_CODE',
        source: 'background',
        payload: {},
      }, {
        timeoutMs,
        responseTimeoutMs: timeoutMs,
        retryDelayMs: 600,
        logMessage: 'Step 9: waiting for the phone verification resend button...',
      });

      if (result?.error) {
        throw new Error(result.error);
      }
      return result || {};
    }

    async function returnToAddPhone(tabId) {
      const timeoutMs = typeof getOAuthFlowStepTimeoutMs === 'function'
        ? await getOAuthFlowStepTimeoutMs(30000, { step: 9, actionLabel: 'return to add-phone page' })
        : 30000;
      const result = await sendToContentScriptResilient('signup-page', {
        type: 'RETURN_TO_ADD_PHONE',
        source: 'background',
        payload: {},
      }, {
        timeoutMs,
        responseTimeoutMs: timeoutMs,
        retryDelayMs: 600,
        logMessage: 'Step 9: returning to add-phone page to replace the phone number...',
      });

      if (result?.error) {
        throw new Error(result.error);
      }
      return result || {};
    }

    async function persistCurrentActivation(activation) {
      await setState({
        [PHONE_ACTIVATION_STATE_KEY]: activation || null,
        [PHONE_VERIFICATION_CODE_STATE_KEY]: '',
      });
    }

    async function persistReusableActivation(activation) {
      await setState({
        [REUSABLE_PHONE_ACTIVATION_STATE_KEY]: activation || null,
      });
    }

    async function clearCurrentActivation() {
      await persistCurrentActivation(null);
    }

    async function clearReusableActivation() {
      await persistReusableActivation(null);
    }

    async function acquirePhoneActivation(state = {}, options = {}) {
      const countryCandidates = resolveCountryCandidates(state);
      const blockedCountryIds = new Set(
        (Array.isArray(options?.blockedCountryIds) ? options.blockedCountryIds : [])
          .map((value) => normalizeCountryId(value, 0))
          .filter((id) => id > 0)
      );
      const allowedCountryIds = new Set(
        countryCandidates
          .map((entry) => normalizeCountryId(entry.id, 0))
          .filter((id) => id > 0 && !blockedCountryIds.has(id))
      );
      const preferredCountryLabel = countryCandidates[0]?.label || HERO_SMS_COUNTRY_LABEL;
      const resolveCountryLabelById = (countryId) => (
        countryCandidates.find((entry) => entry.id === normalizeCountryId(countryId, 0))?.label
        || preferredCountryLabel
      );
      const reuseEnabled = normalizeHeroSmsReuseEnabled(state.heroSmsReuseEnabled);
      const reusableActivation = normalizeActivation(state[REUSABLE_PHONE_ACTIVATION_STATE_KEY]);
      if (
        reuseEnabled
        &&
        reusableActivation
        && !blockedCountryIds.has(normalizeCountryId(reusableActivation.countryId, 0))
        && allowedCountryIds.has(reusableActivation.countryId)
        && reusableActivation.successfulUses < reusableActivation.maxUses
      ) {
        try {
          const reactivated = await reactivatePhoneActivation(state, reusableActivation);
          await addLog(
            `Step 9: reusing ${resolveCountryLabelById(reactivated.countryId)} number ${reactivated.phoneNumber} (${reactivated.successfulUses + 1}/${reactivated.maxUses}).`,
            'info'
          );
          return reactivated;
        } catch (error) {
          await addLog(`Step 9: failed to reuse phone number ${reusableActivation.phoneNumber}, falling back to a new number. ${error.message}`, 'warn');
          await clearReusableActivation();
        }
      }

      const activation = await requestPhoneActivation(state, { blockedCountryIds: Array.from(blockedCountryIds) });
      await addLog(
        `Step 9: acquired ${HERO_SMS_SERVICE_LABEL} / ${resolveCountryLabelById(activation.countryId)} number ${activation.phoneNumber}.`,
        'info'
      );
      return activation;
    }

    async function markActivationReusableAfterSuccess(state, activation) {
      const normalizedActivation = normalizeActivation(activation);
      if (!normalizeHeroSmsReuseEnabled(state?.heroSmsReuseEnabled)) {
        await clearReusableActivation();
        return;
      }
      if (!normalizedActivation) {
        await clearReusableActivation();
        return;
      }

      const successfulUses = normalizedActivation.successfulUses + 1;
      if (successfulUses >= normalizedActivation.maxUses) {
        await clearReusableActivation();
        return;
      }

      await persistReusableActivation({
        ...normalizedActivation,
        successfulUses,
      });
    }

    async function waitForPhoneCodeOrRotateNumber(tabId, state, activation) {
      const normalizedActivation = normalizeActivation(activation);
      if (!normalizedActivation) {
        throw new Error('Phone activation is missing.');
      }

      const waitSeconds = normalizePhoneCodeWaitSeconds(state?.phoneCodeWaitSeconds);
      const timeoutWindows = normalizePhoneCodeTimeoutWindows(state?.phoneCodeTimeoutWindows);
      const pollIntervalSeconds = normalizePhoneCodePollIntervalSeconds(state?.phoneCodePollIntervalSeconds);
      const pollMaxRounds = normalizePhoneCodePollMaxRounds(state?.phoneCodePollMaxRounds);
      let lastLoggedStatus = '';
      let lastLoggedPollCount = 0;
      let resendTriggeredForCurrentNumber = false;

      for (let windowIndex = 1; windowIndex <= timeoutWindows; windowIndex += 1) {
        await addLog(
          `Step 9: waiting up to ${waitSeconds} seconds for SMS on ${normalizedActivation.phoneNumber} (${windowIndex}/${timeoutWindows}).`,
          'info'
        );
        try {
          const code = await pollPhoneActivationCode(state, normalizedActivation, {
            actionLabel: windowIndex === 1
              ? 'poll phone verification code from HeroSMS'
              : 'poll resent phone verification code from HeroSMS',
            timeoutMs: waitSeconds * 1000,
            intervalMs: pollIntervalSeconds * 1000,
            maxRounds: pollMaxRounds,
            onStatus: async ({ elapsedMs, pollCount, statusText }) => {
              const shouldLog = (
                pollCount === 1
                || statusText !== lastLoggedStatus
                || pollCount - lastLoggedPollCount >= 3
              );
              if (!shouldLog) {
                return;
              }
              lastLoggedStatus = statusText;
              lastLoggedPollCount = pollCount;
              await addLog(
                `Step 9: HeroSMS status for ${normalizedActivation.phoneNumber}: ${statusText} (${Math.ceil(elapsedMs / 1000)}s elapsed, round ${pollCount}/${pollMaxRounds}).`,
                'info'
              );
            },
          });
          return {
            code,
            replaceNumber: false,
          };
        } catch (error) {
          if (!isPhoneCodeTimeoutError(error)) {
            throw error;
          }

          if (windowIndex < timeoutWindows) {
            await addLog(
              `Step 9: no SMS arrived for ${normalizedActivation.phoneNumber} within ${waitSeconds} seconds, requesting another SMS.`,
              'warn'
            );
            await requestAdditionalPhoneSms(state, normalizedActivation);
            if (resendTriggeredForCurrentNumber) {
              await addLog(
                `Step 9: resend already used once for ${normalizedActivation.phoneNumber}; continue polling without another page resend to avoid rate limit.`,
                'warn'
              );
              continue;
            }
            try {
              await resendPhoneVerificationCode(tabId);
              resendTriggeredForCurrentNumber = true;
              await addLog('Step 9: clicked "Resend text message" on the phone verification page.', 'info');
            } catch (resendError) {
              if (isPhoneResendThrottledError(resendError)) {
                await addLog(
                  `Step 9: resend is throttled for ${normalizedActivation.phoneNumber}, replacing number immediately. ${resendError.message}`,
                  'warn'
                );
                return {
                  code: '',
                  replaceNumber: true,
                  reason: 'resend_throttled',
                };
              }
              await addLog(`Step 9: failed to click resend on the phone verification page. ${resendError.message}`, 'warn');
            }
            continue;
          }

          await addLog(
            `Step 9: no SMS for ${normalizedActivation.phoneNumber} after ${timeoutWindows} window(s), replacing the number inside step 9.`,
            'warn'
          );
          return {
            code: '',
            replaceNumber: true,
            reason: `sms_timeout_after_${timeoutWindows}_windows`,
          };
        }
      }

      throw new Error('Phone verification did not complete successfully.');
    }

    async function completePhoneVerificationFlow(tabId, initialPageState = null) {
      let state = await getState();
      let activation = normalizeActivation(state[PHONE_ACTIVATION_STATE_KEY]);
      let pageState = initialPageState || await readPhonePageState(tabId);
      let shouldCancelActivation = false;
      let remainingResendRequests = Math.max(0, Number(state.verificationResendCount) || 0);
      const maxNumberReplacementAttempts = normalizePhoneReplacementLimit(
        state.phoneVerificationReplacementLimit
      );
      let usedNumberReplacementAttempts = 0;
      let preferReuseExistingActivationOnAddPhone = false;
      let addPhoneReentryWithSameActivation = 0;
      const countrySmsFailureCounts = new Map();

      const getCountryFailureCount = (countryId) => {
        const normalizedCountryId = normalizeCountryId(countryId, 0);
        if (!normalizedCountryId) {
          return 0;
        }
        return Math.max(0, Math.floor(Number(countrySmsFailureCounts.get(normalizedCountryId)) || 0));
      };

      const markCountrySmsFailure = async (countryId, reason = 'sms_timeout') => {
        const normalizedCountryId = normalizeCountryId(countryId, 0);
        if (!normalizedCountryId) {
          return;
        }
        const nextCount = getCountryFailureCount(normalizedCountryId) + 1;
        countrySmsFailureCounts.set(normalizedCountryId, nextCount);
        if (nextCount >= PHONE_SMS_FAILURE_SKIP_THRESHOLD) {
          const matched = resolveCountryCandidates(state)
            .find((entry) => normalizeCountryId(entry.id, 0) === normalizedCountryId);
          const countryLabel = matched?.label || `Country #${normalizedCountryId}`;
          await addLog(
            `Step 9: ${countryLabel} reached ${nextCount} SMS failures (${reason}); next acquisition will fallback to other selected country candidates first.`,
            'warn'
          );
        }
      };

      const clearCountrySmsFailure = (countryId) => {
        const normalizedCountryId = normalizeCountryId(countryId, 0);
        if (!normalizedCountryId) {
          return;
        }
        countrySmsFailureCounts.delete(normalizedCountryId);
      };

      const getBlockedCountryIds = () => Array.from(countrySmsFailureCounts.entries())
        .filter(([, count]) => Number(count) >= PHONE_SMS_FAILURE_SKIP_THRESHOLD)
        .map(([countryId]) => normalizeCountryId(countryId, 0))
        .filter((countryId) => countryId > 0);

      try {
        while (true) {
          state = await getState();
          if (!activation) {
            activation = normalizeActivation(state[PHONE_ACTIVATION_STATE_KEY]);
          }

          if (pageState?.addPhonePage) {
            if (!activation) {
              activation = await acquirePhoneActivation(state, {
                blockedCountryIds: getBlockedCountryIds(),
              });
              shouldCancelActivation = true;
              await persistCurrentActivation(activation);
              addPhoneReentryWithSameActivation = 0;
            } else if (preferReuseExistingActivationOnAddPhone) {
              addPhoneReentryWithSameActivation += 1;
              if (addPhoneReentryWithSameActivation > 1) {
                usedNumberReplacementAttempts += 1;
                if (usedNumberReplacementAttempts > maxNumberReplacementAttempts) {
                  throw new Error(
                    `Step 9: phone verification did not succeed after ${maxNumberReplacementAttempts} number replacements. Last reason: returned_to_add_phone_loop.`
                  );
                }
                await addLog(
                  `Step 9: current number ${activation.phoneNumber} returned to add-phone repeatedly, replacing number (${usedNumberReplacementAttempts}/${maxNumberReplacementAttempts}).`,
                  'warn'
                );
                if (shouldCancelActivation && activation) {
                  await cancelPhoneActivation(state, activation);
                }
                await clearCurrentActivation();
                activation = null;
                shouldCancelActivation = false;
                preferReuseExistingActivationOnAddPhone = false;
                addPhoneReentryWithSameActivation = 0;
                pageState = {
                  ...pageState,
                  addPhonePage: true,
                  phoneVerificationPage: false,
                };
                continue;
              }
              await addLog(
                `Step 9: add-phone returned, re-submitting current number ${activation.phoneNumber} before requesting a new number.`,
                'warn'
              );
            }

            let submitResult = await submitPhoneNumber(tabId, activation.phoneNumber, activation);
            if (submitResult.addPhoneRejected) {
              const addPhoneRejectText = String(submitResult.errorText || submitResult.url || 'unknown error');
              if (isPhoneNumberUsedError(addPhoneRejectText)) {
                usedNumberReplacementAttempts += 1;
                if (usedNumberReplacementAttempts > maxNumberReplacementAttempts) {
                  throw new Error(
                    `Step 9: phone verification did not succeed after ${maxNumberReplacementAttempts} number replacements. Last reason: phone_number_used.`
                  );
                }

                await addLog(
                  `Step 9: add-phone rejected ${activation.phoneNumber} as already used (${addPhoneRejectText}), replacing number (${usedNumberReplacementAttempts}/${maxNumberReplacementAttempts}).`,
                  'warn'
                );
                if (shouldCancelActivation && activation) {
                  await cancelPhoneActivation(state, activation);
                }
                await clearCurrentActivation();
                activation = null;
                shouldCancelActivation = false;
                preferReuseExistingActivationOnAddPhone = false;
                addPhoneReentryWithSameActivation = 0;
                pageState = {
                  ...pageState,
                  ...submitResult,
                  addPhonePage: true,
                  phoneVerificationPage: false,
                };
                continue;
              }

              await addLog(
                `Step 9: add-phone rejected current number but did not mark it as used (${addPhoneRejectText}), retrying once with the same number.`,
                'warn'
              );
              submitResult = await submitPhoneNumber(tabId, activation.phoneNumber, activation);
              if (submitResult.addPhoneRejected) {
                throw new Error(
                  `Step 9: add-phone keeps rejecting current number without explicit "used" status: ${submitResult.errorText || submitResult.url || 'unknown error'}.`
                );
              }
            }

            await addLog('Step 9: submitted the phone number on add-phone page.', 'info');
            pageState = {
              ...pageState,
              ...submitResult,
              addPhonePage: false,
              phoneVerificationPage: true,
            };
            preferReuseExistingActivationOnAddPhone = false;
            addPhoneReentryWithSameActivation = 0;
          }

          if (!pageState?.phoneVerificationPage) {
            pageState = await readPhonePageState(tabId);
          }

          if (!pageState?.phoneVerificationPage) {
            return pageState;
          }

          if (!activation) {
            throw new Error('The auth page is waiting for a phone verification code, but no HeroSMS activation is stored for this run.');
          }

          let shouldReplaceNumber = false;
          let replaceReason = '';

          for (let attempt = 1; attempt <= DEFAULT_PHONE_SUBMIT_ATTEMPTS; attempt += 1) {
            throwIfStopped();

            const codeResult = await waitForPhoneCodeOrRotateNumber(tabId, state, activation);
            if (codeResult.replaceNumber) {
              shouldReplaceNumber = true;
              replaceReason = codeResult.reason || 'sms_not_received';
              break;
            }

            await setState({
              [PHONE_VERIFICATION_CODE_STATE_KEY]: String(codeResult.code || '').trim(),
            });
            await addLog(`Step 9: received phone verification code ${codeResult.code}.`, 'info');
            const submitResult = await submitPhoneVerificationCode(tabId, codeResult.code);

            if (submitResult.returnedToAddPhone) {
              await addLog(
                'Step 9: phone verification returned to add-phone after code submission, will try current number first.',
                'warn'
              );
              preferReuseExistingActivationOnAddPhone = true;
              pageState = {
                ...pageState,
                ...submitResult,
                addPhonePage: true,
                phoneVerificationPage: false,
              };
              break;
            }

            if (submitResult.invalidCode) {
              const invalidErrorText = String(submitResult.errorText || submitResult.url || 'unknown error');
              if (isPhoneNumberUsedError(invalidErrorText)) {
                shouldReplaceNumber = true;
                replaceReason = 'phone_number_used';
                await addLog(
                  `Step 9: phone number was rejected as already used (${invalidErrorText}), replacing with a new number immediately.`,
                  'warn'
                );
                break;
              }

              if (attempt >= DEFAULT_PHONE_SUBMIT_ATTEMPTS) {
                shouldReplaceNumber = true;
                replaceReason = 'code_rejected';
                await addLog(
                  `Step 9: phone verification code was rejected ${DEFAULT_PHONE_SUBMIT_ATTEMPTS} times (${invalidErrorText}), replacing the number.`,
                  'warn'
                );
                break;
              }

              if (remainingResendRequests > 0) {
                remainingResendRequests -= 1;
                await requestAdditionalPhoneSms(state, activation);
                try {
                  await resendPhoneVerificationCode(tabId);
                  await addLog('Step 9: clicked "Resend text message" after the phone code was rejected.', 'info');
                } catch (resendError) {
                  await addLog(`Step 9: failed to click resend after code rejection. ${resendError.message}`, 'warn');
                }
                await addLog(
                  `Step 9: phone verification code was rejected, requested another SMS (${remainingResendRequests} resend attempts left).`,
                  'warn'
                );
              } else {
                await addLog(
                  'Step 9: phone verification code was rejected and the configured resend budget is exhausted, retrying with the current activation window.',
                  'warn'
                );
              }
              continue;
            }

            await completePhoneActivation(state, activation);
            await markActivationReusableAfterSuccess(state, activation);
            clearCountrySmsFailure(activation.countryId);
            shouldCancelActivation = false;
            await clearCurrentActivation();
            addPhoneReentryWithSameActivation = 0;
            await addLog('Step 9: phone verification finished, waiting for OAuth consent.', 'ok');
            return submitResult;
          }

          if (!shouldReplaceNumber) {
            if (pageState?.addPhonePage) {
              continue;
            }
            throw new Error('Phone verification did not complete successfully.');
          }

          if (
            activation
            && (replaceReason === 'resend_throttled' || /^sms_timeout_after_/i.test(String(replaceReason || '')))
          ) {
            await markCountrySmsFailure(activation.countryId, replaceReason || 'sms_timeout');
          }

          usedNumberReplacementAttempts += 1;
          if (usedNumberReplacementAttempts > maxNumberReplacementAttempts) {
            throw new Error(
              `Step 9: phone verification did not succeed after ${maxNumberReplacementAttempts} number replacements. Last reason: ${replaceReason || 'unknown'}.`
            );
          }

          if (shouldCancelActivation && activation) {
            await cancelPhoneActivation(state, activation);
          }
          await clearCurrentActivation();
          activation = null;
          shouldCancelActivation = false;
          addPhoneReentryWithSameActivation = 0;

          let returnResult = { addPhonePage: true, phoneVerificationPage: false };
          try {
            returnResult = await returnToAddPhone(tabId);
          } catch (returnError) {
            await addLog(`Step 9: failed to return to add-phone page before replacing number. ${returnError.message}`, 'warn');
          }

          await addLog(
            `Step 9: replacing number and retrying inside step 9 (${usedNumberReplacementAttempts}/${maxNumberReplacementAttempts}).`,
            'warn'
          );
          pageState = {
            ...pageState,
            ...returnResult,
            addPhonePage: true,
            phoneVerificationPage: false,
          };
        }
      } catch (error) {
        if (shouldCancelActivation && activation) {
          await cancelPhoneActivation(state, activation);
        }
        await clearCurrentActivation();
        throw sanitizePhoneRestartStep7Error(sanitizePhoneCodeTimeoutError(error));
      }
    }

    return {
      completePhoneVerificationFlow,
      normalizeActivation,
      pollPhoneActivationCode,
      reactivatePhoneActivation,
      requestPhoneActivation,
    };
  }

  return {
    createPhoneVerificationHelpers,
  };
});
