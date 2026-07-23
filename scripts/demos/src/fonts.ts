import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

export const fontsLoaded = Promise.all([
  loadFont({
    family: "Geist Variable",
    url: staticFile("geist.woff2"),
    weight: "100 900",
  }),
  loadFont({
    family: "Geist Mono Variable",
    url: staticFile("geist-mono.woff2"),
    weight: "100 900",
  }),
  loadFont({
    family: "Geist Pixel",
    url: staticFile("geist-pixel.woff2"),
    weight: "400",
  }),
]);
