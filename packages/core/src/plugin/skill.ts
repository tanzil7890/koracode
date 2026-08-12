/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"

export const Plugin = define({
  id: "skill",
  effect: () => Effect.void,
})
