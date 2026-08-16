import { redirect } from "next/navigation";

/**
 * UI redraw 已并入生产 Pet 路由的 dev preview：
 * /companion/pet?preview=redraw
 */
export default function PetJourneyUiRedrawRedirect() {
  redirect("/companion/pet?preview=redraw");
}
