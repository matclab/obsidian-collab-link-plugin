import { flushSync, mount, unmount } from "svelte";
import type { RemoteImages } from "../../view-model/remote-images.js";
import type { Preview } from "../reading/preview.js";
import RemoteImagesBanner from "./RemoteImagesBanner.svelte";

function hostOf(src: string): string {
  try {
    return new URL(src).hostname;
  } catch {
    return src;
  }
}

/** The banner of a document's remote images (ADR-0055 §4), in `parent`:
 * what `preview` finds in the text, rendered or not, against what
 * `images` grants. Returns a stop. */
export function attachRemoteImagesBanner(
  parent: Element,
  preview: Pick<Preview, "onImages">,
  images: RemoteImages,
): () => void {
  const banner = mount(RemoteImagesBanner, {
    target: parent,
    props: {
      onShow: (always: boolean) => images.grantDocument(always),
      onStop: () => images.revoke(),
    },
  });
  let sources: readonly string[] = [];
  const show = () => {
    const hidden = sources.filter((src) => !images.granted(src));
    banner.set({
      total: sources.length,
      hidden: hidden.length,
      hosts: [...new Set(hidden.map(hostOf))],
      grant: images.grant,
    });
    flushSync();
  };
  preview.onImages((found) => {
    sources = found;
    show();
  });
  const stop = images.subscribe(show);
  return () => {
    stop();
    void unmount(banner);
  };
}
