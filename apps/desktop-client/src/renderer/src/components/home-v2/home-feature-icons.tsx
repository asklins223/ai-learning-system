import {
  BookOpenText,
  CalendarCheck2,
  Gauge,
  MessageCircle,
  Orbit,
  Search,
  Sparkles,
  SquareStack,
  type LucideIcon,
} from "lucide-react";
import type { HomeFeatureIconId } from "./home-feature-registry";

export const HOME_FEATURE_ICONS: Readonly<Record<HomeFeatureIconId, LucideIcon>> = Object.freeze({
  book: BookOpenText,
  calendar: CalendarCheck2,
  cards: SquareStack,
  catalog: BookOpenText,
  companion: MessageCircle,
  notebook: BookOpenText,
  orbit: Orbit,
  search: Search,
  settings: Gauge,
  target: Sparkles,
});
