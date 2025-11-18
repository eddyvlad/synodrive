export const normalizePath = (path: string) => path.replace(/\\/g, "/");

export const requestUrl = async (options: any) => {
  // The api.test suite provides a spy for this function.
  if (typeof options === "function") {
    return options();
  }
  return { status: 200, headers: {}, json: {}, arrayBuffer: new ArrayBuffer(0) } as any;
};

export class Notice {
  constructor(public message: string) {}
}

export class Plugin {}

export type TFile = any;
export type TAbstractFile = any;
export const Platform = { isMobile: false };
