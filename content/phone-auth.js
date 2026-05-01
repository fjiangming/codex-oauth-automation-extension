(function attachPhoneAuthModule(root, factory) {
  root.MultiPagePhoneAuth = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createPhoneAuthModule() {
  function createPhoneAuthHelpers(deps = {}) {
    const {
      fillInput,
      getActionText,
      getPageTextSnapshot,
      getVerificationErrorText,
      humanPause,
      isActionEnabled,
      isAddPhonePageReady,
      isConsentReady,
      isPhoneVerificationPageReady,
      isVisibleElement,
      simulateClick,
      sleep,
      throwIfStopped,
      waitForElement,
    } = deps;
    const PHONE_RESEND_THROTTLED_ERROR_PREFIX = 'PHONE_RESEND_THROTTLED::';
    const PHONE_RESEND_THROTTLED_PATTERN = /tried\s+to\s+resend\s+too\s+many\s+times|please\s+try\s+again\s+later|too\s+many\s+resend|resend\s+too\s+many|发送.*过于频繁|稍后再试|重试次数过多/i;

    function dispatchInputEvents(element) {
      if (!element) return;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function normalizePhoneDigits(value) {
      let digits = String(value || '').replace(/\D+/g, '');
      if (digits.startsWith('00')) {
        digits = digits.slice(2);
      }
      return digits;
    }

    function normalizeCountryLabel(value) {
      return String(value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/&/g, ' and ')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    }

    function getOptionLabel(option) {
      return String(option?.textContent || option?.label || '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function normalizeCountryOptionValue(value) {
      return String(value || '').trim().toUpperCase();
    }

    function getRegionDisplayName(regionCode, locale) {
      const normalizedRegionCode = normalizeCountryOptionValue(regionCode);
      const normalizedLocale = String(locale || '').trim();
      if (!/^[A-Z]{2}$/.test(normalizedRegionCode) || !normalizedLocale || typeof Intl?.DisplayNames !== 'function') {
        return '';
      }
      try {
        return String(
          new Intl.DisplayNames([normalizedLocale], { type: 'region' }).of(normalizedRegionCode) || ''
        ).trim();
      } catch {
        return '';
      }
    }

    function getCountryOptionMatchLabels(option) {
      const labels = new Set();
      const pushLabel = (value) => {
        const label = String(value || '').replace(/\s+/g, ' ').trim();
        if (label) {
          labels.add(label);
        }
      };

      pushLabel(getOptionLabel(option));

      const regionCode = normalizeCountryOptionValue(option?.value);
      if (/^[A-Z]{2}$/.test(regionCode)) {
        pushLabel(regionCode);
        pushLabel(getRegionDisplayName(regionCode, 'en'));

        const pageLocale = String(
          document?.documentElement?.lang
          || document?.documentElement?.getAttribute?.('lang')
          || self?.navigator?.language
          || ''
        ).trim();
        if (pageLocale && !/^en(?:[-_]|$)/i.test(pageLocale)) {
          pushLabel(getRegionDisplayName(regionCode, pageLocale));
        }
      }

      return Array.from(labels);
    }

    function isSameCountryOption(left, right) {
      if (!left || !right) {
        return false;
      }

      const leftValue = normalizeCountryOptionValue(left.value);
      const rightValue = normalizeCountryOptionValue(right.value);
      if (leftValue && rightValue) {
        return leftValue === rightValue;
      }

      return normalizeCountryLabel(getOptionLabel(left)) === normalizeCountryLabel(getOptionLabel(right));
    }

    function extractDialCodeFromText(value) {
      const match = String(value || '').match(/\(\+\s*(\d{1,4})\s*\)|\+\s*(\d{1,4})\b/);
      return String(match?.[1] || match?.[2] || '').trim();
    }

    function getCountryButtonText() {
      const form = getAddPhoneForm();
      if (!form) return '';
      const button = form.querySelector('button[aria-haspopup="listbox"]');
      if (!button) return '';
      const valueNode = button.querySelector('.react-aria-SelectValue');
      return String(valueNode?.textContent || button.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function getDisplayedDialCode() {
      const buttonDialCode = extractDialCodeFromText(getCountryButtonText());
      if (buttonDialCode) {
        return buttonDialCode;
      }

      const phoneInput = getPhoneInput();
      const fieldRoot = phoneInput?.closest('fieldset') || phoneInput?.closest('form') || getAddPhoneForm();
      if (!fieldRoot) {
        return '';
      }

      const visibleSpan = Array.from(fieldRoot.querySelectorAll('span'))
        .find((element) => isVisibleElement(element) && /^\d{1,4}$/.test(String(element.textContent || '').trim()));
      return String(visibleSpan?.textContent || '').trim();
    }

    function toNationalPhoneNumber(value, dialCode) {
      const digits = normalizePhoneDigits(value);
      const normalizedDialCode = normalizePhoneDigits(dialCode);
      if (!digits) {
        return '';
      }
      if (normalizedDialCode && digits.startsWith(normalizedDialCode) && digits.length > normalizedDialCode.length) {
        return digits.slice(normalizedDialCode.length);
      }
      return digits;
    }

    function toE164PhoneNumber(value, dialCode) {
      const digits = normalizePhoneDigits(value);
      const normalizedDialCode = normalizePhoneDigits(dialCode);
      if (!digits) {
        return '';
      }
      if (!normalizedDialCode) {
        return digits.startsWith('+') ? digits : `+${digits}`;
      }
      if (digits.startsWith(normalizedDialCode)) {
        return `+${digits}`;
      }
      if (digits.startsWith('0')) {
        return `+${normalizedDialCode}${digits.slice(1)}`;
      }
      return `+${normalizedDialCode}${digits}`;
    }

    function getAddPhoneForm() {
      return document.querySelector('form[action*="/add-phone" i]');
    }

    function getPhoneVerificationForm() {
      return document.querySelector('form[action*="/phone-verification" i]');
    }

    function getPhoneInput() {
      const form = getAddPhoneForm();
      if (!form) return null;
      const input = form.querySelector(
        'input[type="tel"], input[name="__reservedForPhoneNumberInput_tel"], input[autocomplete="tel"]'
      );
      return input && isVisibleElement(input) ? input : null;
    }

    function getHiddenPhoneNumberInput() {
      const form = getAddPhoneForm();
      if (!form) return null;
      return form.querySelector('input[name="phoneNumber"]');
    }

    function getCountrySelect() {
      const form = getAddPhoneForm();
      if (!form) return null;
      return form.querySelector('select');
    }

    function getSelectedCountryOption() {
      const select = getCountrySelect();
      if (!select || select.selectedIndex < 0) {
        return null;
      }
      return select.options[select.selectedIndex] || null;
    }

    function findCountryOptionByLabel(countryLabel) {
      const select = getCountrySelect();
      if (!select) {
        return null;
      }
      const normalizedTarget = normalizeCountryLabel(countryLabel);
      if (!normalizedTarget) {
        return null;
      }

      const options = Array.from(select.options);
      return options.find((option) => (
        getCountryOptionMatchLabels(option).some((label) => normalizeCountryLabel(label) === normalizedTarget)
      ))
        || options.find((option) => {
          const normalizedLabels = getCountryOptionMatchLabels(option)
            .map((label) => normalizeCountryLabel(label))
            .filter(Boolean);
          return normalizedLabels.some((optionLabel) => (
            optionLabel.includes(normalizedTarget) || normalizedTarget.includes(optionLabel)
          ));
        })
        || null;
    }

    async function ensureCountrySelected(countryLabel) {
      const select = getCountrySelect();
      if (!select) {
        return false;
      }

      const targetOption = findCountryOptionByLabel(countryLabel);
      if (!targetOption) {
        throw new Error(`Add-phone page is missing the country option for "${countryLabel}".`);
      }

      const selectedOption = getSelectedCountryOption();
      if (selectedOption && isSameCountryOption(selectedOption, targetOption)) {
        return true;
      }

      select.value = String(targetOption.value || '');
      dispatchInputEvents(select);
      await sleep(250);

      const nextSelectedOption = getSelectedCountryOption();
      return Boolean(nextSelectedOption && isSameCountryOption(nextSelectedOption, targetOption));
    }

    function getAddPhoneSubmitButton() {
      const form = getAddPhoneForm();
      if (!form) return null;
      const buttons = Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"]'));
      return buttons.find((button) => isVisibleElement(button) && isActionEnabled(button))
        || buttons.find((button) => isVisibleElement(button))
        || null;
    }

    function getPhoneVerificationCodeInput() {
      const form = getPhoneVerificationForm();
      if (!form) return null;
      const input = form.querySelector(
        'input[name="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"]'
      );
      return input && isVisibleElement(input) ? input : null;
    }

    function getPhoneVerificationSubmitButton() {
      const form = getPhoneVerificationForm();
      if (!form) return null;
      const buttons = Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"]'));
      return buttons.find((button) => {
        if (!isVisibleElement(button) || !isActionEnabled(button)) return false;
        const intent = String(button.getAttribute('value') || '').trim().toLowerCase();
        if (intent === 'resend') return false;
        return true;
      }) || buttons.find((button) => isVisibleElement(button));
    }

    function getPhoneVerificationResendButton(options = {}) {
      const { allowDisabled = false } = options;
      const form = getPhoneVerificationForm();
      if (!form) return null;
      const buttons = Array.from(form.querySelectorAll('button, input[type="submit"], input[type="button"]'));
      return buttons.find((button) => {
        if (!isVisibleElement(button)) return false;
        if (!allowDisabled && !isActionEnabled(button)) return false;
        const intent = String(button.getAttribute('value') || '').trim().toLowerCase();
        if (intent === 'resend') return true;
        return /resend/i.test(getActionText(button));
      }) || null;
    }

    function getPhoneVerificationDisplayedPhone() {
      const text = getPageTextSnapshot();
      const matches = text.match(/\+\d[\d\s-]{6,}\d/g);
      return matches?.[0] ? matches[0].replace(/\s+/g, ' ').trim() : '';
    }

    function getAddPhoneErrorText() {
      const form = getAddPhoneForm();
      if (!form) {
        return '';
      }

      const messages = [];
      const selectors = [
        '.react-aria-FieldError',
        '[slot="errorMessage"]',
        '[id$="-error"]',
        '[data-invalid="true"] + *',
        '[aria-invalid="true"] + *',
        '[class*="error"]',
      ];
      for (const selector of selectors) {
        form.querySelectorAll(selector).forEach((el) => {
          const text = String(el?.textContent || '').replace(/\s+/g, ' ').trim();
          if (text) {
            messages.push(text);
          }
        });
      }

      const invalidInput = form.querySelector('input[aria-invalid="true"], input[data-invalid="true"]');
      if (invalidInput) {
        const wrapper = invalidInput.closest('form, [data-rac], div');
        const text = String(wrapper?.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) {
          messages.push(text);
        }
      }

      const preferred = messages.find((text) => (
        /already|used|linked|eligible|invalid|phone|号码|手机号|错误|失败|try\s+again/i.test(text)
      ));
      return preferred || messages[0] || '';
    }

    function getPhoneVerificationInlineMessages() {
      const form = getPhoneVerificationForm();
      if (!form) {
        return [];
      }
      const messages = [];
      const selectors = [
        '.react-aria-FieldError',
        '[slot="errorMessage"]',
        '[id$="-error"]',
        '[data-invalid="true"] + *',
        '[aria-invalid="true"] + *',
        '[class*="error"]',
      ];
      for (const selector of selectors) {
        form.querySelectorAll(selector).forEach((element) => {
          const text = String(element?.textContent || '').replace(/\s+/g, ' ').trim();
          if (text) {
            messages.push(text);
          }
        });
      }
      const verificationError = String(getVerificationErrorText?.() || '').trim();
      if (verificationError) {
        messages.push(verificationError);
      }
      return messages;
    }

    function getPhoneResendThrottleText() {
      const inlineMatch = getPhoneVerificationInlineMessages()
        .find((text) => PHONE_RESEND_THROTTLED_PATTERN.test(text));
      if (inlineMatch) {
        return inlineMatch;
      }
      const pageSnapshot = String(getPageTextSnapshot?.() || '').replace(/\s+/g, ' ').trim();
      if (pageSnapshot && PHONE_RESEND_THROTTLED_PATTERN.test(pageSnapshot)) {
        const concise = pageSnapshot.match(
          /tried\s+to\s+resend\s+too\s+many\s+times[^.。!?]*[.。!?]?|please\s+try\s+again\s+later[^.。!?]*[.。!?]?|发送.*过于频繁[^。!?]*[。!?]?|稍后再试[^。!?]*[。!?]?/i
        );
        return String(concise?.[0] || pageSnapshot).trim();
      }
      return '';
    }

    async function waitForAddPhoneReady(timeout = 20000) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        throwIfStopped();
        if (isAddPhonePageReady()) {
          return true;
        }
        await sleep(150);
      }
      throw new Error('Timed out waiting for add-phone page.');
    }

    async function waitForPhoneVerificationReady(timeout = 20000) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        throwIfStopped();
        if (isPhoneVerificationPageReady()) {
          return {
            phoneVerificationPage: true,
            displayedPhone: getPhoneVerificationDisplayedPhone(),
            url: location.href,
          };
        }
        if (isAddPhonePageReady()) {
          const errorText = getAddPhoneErrorText();
          if (errorText) {
            return {
              addPhoneRejected: true,
              errorText,
              url: location.href,
            };
          }
        }
        await sleep(150);
      }
      if (isAddPhonePageReady()) {
        const errorText = getAddPhoneErrorText();
        if (errorText) {
          return {
            addPhoneRejected: true,
            errorText,
            url: location.href,
          };
        }
      }
      throw new Error('Timed out waiting for phone verification page.');
    }

    async function submitPhoneNumber(payload = {}) {
      const countryLabel = String(payload.countryLabel || '').trim();
      if (!countryLabel) {
        throw new Error('Missing country label for add-phone submission.');
      }

      await waitForAddPhoneReady();
      const countrySelected = await ensureCountrySelected(countryLabel);
      if (!countrySelected) {
        throw new Error(`Failed to select "${countryLabel}" on the add-phone page.`);
      }

      const dialCode = getDisplayedDialCode();
      if (!dialCode) {
        throw new Error(`Could not determine the dial code for "${countryLabel}" on the add-phone page.`);
      }

      const phoneNumber = toE164PhoneNumber(payload.phoneNumber, dialCode);
      const nationalPhoneNumber = toNationalPhoneNumber(payload.phoneNumber, dialCode);
      if (!phoneNumber || !nationalPhoneNumber) {
        throw new Error('Missing phone number for add-phone submission.');
      }

      const phoneInput = getPhoneInput() || await waitForElement(
        'input[type="tel"], input[name="__reservedForPhoneNumberInput_tel"], input[autocomplete="tel"]',
        10000
      );
      const hiddenPhoneNumberInput = getHiddenPhoneNumberInput();
      const submitButton = getAddPhoneSubmitButton();

      if (!phoneInput) {
        throw new Error('Add-phone page is missing the phone number input.');
      }
      if (!submitButton) {
        throw new Error('Add-phone page is missing the submit button.');
      }

      await humanPause(250, 700);
      fillInput(phoneInput, nationalPhoneNumber);
      if (hiddenPhoneNumberInput) {
        hiddenPhoneNumberInput.value = phoneNumber;
        dispatchInputEvents(hiddenPhoneNumberInput);
      }
      await sleep(250);
      simulateClick(submitButton);
      return waitForPhoneVerificationReady();
    }

    async function waitForPhoneVerificationOutcome(timeout = 30000) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        throwIfStopped();

        const errorText = getVerificationErrorText();
        if (errorText) {
          return {
            invalidCode: true,
            errorText,
            url: location.href,
          };
        }

        if (isConsentReady()) {
          return {
            success: true,
            consentReady: true,
            url: location.href,
          };
        }

        if (isAddPhonePageReady()) {
          return {
            returnedToAddPhone: true,
            url: location.href,
          };
        }

        await sleep(150);
      }

      if (isPhoneVerificationPageReady()) {
        return {
          invalidCode: true,
          errorText: getVerificationErrorText() || 'Phone verification page stayed in place after code submission.',
          url: location.href,
        };
      }

      return {
        success: true,
        assumed: true,
        url: location.href,
      };
    }

    async function submitPhoneVerificationCode(payload = {}) {
      const code = String(payload.code || '').trim();
      if (!code) {
        throw new Error('Missing phone verification code.');
      }

      await waitForPhoneVerificationReady();
      const codeInput = getPhoneVerificationCodeInput() || await waitForElement(
        'input[name="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"]',
        10000
      );
      const submitButton = getPhoneVerificationSubmitButton();

      if (!codeInput) {
        throw new Error('Phone verification page is missing the code input.');
      }
      if (!submitButton) {
        throw new Error('Phone verification page is missing the submit button.');
      }

      await humanPause(250, 700);
      fillInput(codeInput, code);
      await sleep(250);
      simulateClick(submitButton);
      return waitForPhoneVerificationOutcome();
    }

    async function resendPhoneVerificationCode(timeout = 45000) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        throwIfStopped();
        const throttledText = getPhoneResendThrottleText();
        if (throttledText) {
          throw new Error(`${PHONE_RESEND_THROTTLED_ERROR_PREFIX}${throttledText}`);
        }
        const resendButton = getPhoneVerificationResendButton({ allowDisabled: true });
        if (resendButton && isActionEnabled(resendButton)) {
          await humanPause(250, 700);
          simulateClick(resendButton);
          await sleep(1000);
          const afterClickThrottleText = getPhoneResendThrottleText();
          if (afterClickThrottleText) {
            throw new Error(`${PHONE_RESEND_THROTTLED_ERROR_PREFIX}${afterClickThrottleText}`);
          }
          return {
            resent: true,
            url: location.href,
          };
        }
        await sleep(250);
      }

      const timeoutThrottleText = getPhoneResendThrottleText();
      if (timeoutThrottleText) {
        throw new Error(`${PHONE_RESEND_THROTTLED_ERROR_PREFIX}${timeoutThrottleText}`);
      }

      throw new Error('Timed out waiting for the phone verification resend button.');
    }

    async function returnToAddPhone(timeout = 20000) {
      if (isAddPhonePageReady()) {
        return {
          addPhonePage: true,
          url: location.href,
        };
      }

      if (!isPhoneVerificationPageReady()) {
        throw new Error('The auth page is not currently on phone verification or add-phone page.');
      }

      location.assign('/add-phone');
      await waitForAddPhoneReady(timeout);
      return {
        addPhonePage: true,
        url: location.href,
      };
    }

    return {
      getPhoneVerificationDisplayedPhone,
      isPhoneVerificationPageReady,
      resendPhoneVerificationCode,
      returnToAddPhone,
      submitPhoneNumber,
      submitPhoneVerificationCode,
      toE164PhoneNumber,
    };
  }

  return {
    createPhoneAuthHelpers,
  };
});
