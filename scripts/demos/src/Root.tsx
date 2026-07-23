import React from "react";
import { Composition } from "remotion";
import "./fonts";
import { PutUrl } from "./loops/PutUrl";
import { StagedLoop } from "./loops/StagedLoop";
import { BeforeAfter } from "./loops/BeforeAfter";
import { Why } from "./loops/Why";

const SIZE = { width: 1080, height: 1080, fps: 30 } as const;

export const Root: React.FC = () => (
  <>
    <Composition id="put-url" component={PutUrl} durationInFrames={210} {...SIZE} />
    <Composition id="staged-loop" component={StagedLoop} durationInFrames={390} {...SIZE} />
    <Composition id="before-after" component={BeforeAfter} durationInFrames={240} {...SIZE} />
    <Composition id="why" component={Why} durationInFrames={240} {...SIZE} />
  </>
);
