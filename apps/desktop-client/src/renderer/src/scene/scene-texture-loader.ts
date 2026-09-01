import { DOMAdapter, Texture, type ALPHA_MODES } from "pixi.js";

export type SceneTextureAlphaMode = Extract<
  ALPHA_MODES,
  "no-premultiply-alpha" | "premultiply-alpha-on-upload" | "premultiplied-alpha"
>;

export type SceneTextureLoadOptions = Readonly<{
  /** How the decoded source pixels should be uploaded and blended by Pixi. */
  readonly alphaMode?: SceneTextureAlphaMode;
}>;

type SceneImage = ReturnType<ReturnType<typeof DOMAdapter.get>["createImage"]> & {
  decoding?: string;
};

function createAbortError(): Error {
  const error = new Error("Scene texture loading was cancelled.");
  error.name = "AbortError";
  return error;
}

function createLoadError(url: string): Error {
  return new Error(`Unable to load scene texture: ${url}`);
}

/**
 * Load a manifest-approved local image into a Pixi Texture.
 *
 * The packaged client serves assets through `ailearn-app://`, while the
 * renderer CSP does not grant fetch() access to that protocol. Keep this
 * Image -> Texture boundary until that transport contract changes. The
 * returned texture is caller-owned; this helper never destroys it.
 */
export function loadSceneImageTexture(
  url: string,
  signal?: AbortSignal,
  options?: SceneTextureLoadOptions,
): Promise<Texture> {
  return new Promise((resolve, reject) => {
    let image: SceneImage;
    try {
      image = DOMAdapter.get().createImage() as SceneImage;
    } catch (error) {
      reject(error instanceof Error ? error : createLoadError(url));
      return;
    }
    let settled = false;

    const cleanup = (): void => {
      signal?.removeEventListener("abort", abort);
      image.onload = null;
      image.onerror = null;
    };

    const fail = (reason: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(reason instanceof Error ? reason : createLoadError(url));
    };

    function abort(): void {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        image.src = "";
      } catch {
        // Clearing an already-failed custom-protocol image is best effort.
      }
      reject(createAbortError());
    }

    if (signal?.aborted) {
      abort();
      return;
    }

    signal?.addEventListener("abort", abort, { once: true });
    try {
      if ("decoding" in image) image.decoding = "async";
      image.onload = () => {
        if (signal?.aborted) {
          abort();
          return;
        }
        try {
          const texture = options?.alphaMode === undefined
            ? Texture.from(image)
            : Texture.from({
              // Pixi's DOMAdapter exposes the browser image as its portable
              // ImageLike interface, while TextureSourceOptions still uses
              // the narrower ImageResource union for this overload.
              resource: image as unknown as HTMLImageElement,
              alphaMode: options.alphaMode,
            });
          settled = true;
          cleanup();
          resolve(texture);
        } catch (error) {
          fail(error);
        }
      };
      image.onerror = () => fail(createLoadError(url));
      image.src = url;
    } catch (error) {
      fail(error);
    }
  });
}
