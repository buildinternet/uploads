import type { APIRoute } from "astro";
import { handleAgentSkillsIndex } from "../../../worker";

export const prerender = false;

export const ALL: APIRoute = ({ request }) => handleAgentSkillsIndex(request);
