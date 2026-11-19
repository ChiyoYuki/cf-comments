type Turnstile = {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
      "response-field": false;
      size: "flexible";
    },
  ) => string;
  reset: (widget: string) => void;
  remove: (widget: string) => void;
};

let loading: Promise<Turnstile> | undefined;

export function loadTurnstile(): Promise<Turnstile> {
  const browser = window as Window & { turnstile?: Turnstile };
  if (browser.turnstile) return Promise.resolve(browser.turnstile);
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    const loaded = () => {
      if (browser.turnstile) resolve(browser.turnstile);
      else reject(new Error("Turnstile did not initialize."));
    };
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    const timeout = window.setTimeout(() => {
      script.remove();
      reject(new Error("Turnstile timed out."));
    }, 12000);
    script.addEventListener(
      "load",
      () => {
        clearTimeout(timeout);
        loaded();
      },
      { once: true },
    );
    script.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        script.remove();
        reject(new Error("Could not load Turnstile."));
      },
      { once: true },
    );
    document.head.append(script);
  }).catch((error) => {
    loading = undefined;
    throw error;
  });
  return loading;
}
