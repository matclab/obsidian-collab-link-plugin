// The page of `/auth-return` (ADR-0041): builds its environment from the
// browser, as `main.ts` does for the page; the rest is
// `account/auth-return.ts`.
import { forwardSignInReturn } from "./account/auth-return.js";
import { LANGUAGE_KEY, chooseLanguage, setLanguage } from "./i18n/index.js";

let kept: string | null = null;
try {
  kept = window.localStorage.getItem(LANGUAGE_KEY);
} catch {}
setLanguage(
  chooseLanguage(kept, navigator.languages),
  document.documentElement,
);

forwardSignInReturn({
  hash: window.location.hash,
  pathname: window.location.pathname,
  replaceAddress: (url) => window.history.replaceState(null, "", url),
  post: (name, data) => {
    const channel = new BroadcastChannel(name);
    channel.postMessage(data);
    channel.close();
  },
  close: () => window.close(),
  say: (text) => {
    const said = document.createElement("p");
    said.textContent = text;
    document.body.replaceChildren(said);
  },
});
