import {
  BrainCircuit,
  BookOpenText,
  CalendarCheck2,
  CalendarDays,
  Gauge,
  MessageCircle,
  Orbit,
  Search,
  Sparkles,
  SquareStack,
  UserRoundCog,
  type LucideIcon,
} from "lucide-react";
import type { HomeFeatureIconId } from "./home-feature-registry";

export const HOME_FEATURE_ICONS: Readonly<Record<HomeFeatureIconId, LucideIcon>> = Object.freeze({
  activity: CalendarDays,
  book: BookOpenText,
  brain: BrainCircuit,
  calendar: CalendarCheck2,
  cards: SquareStack,
  catalog: BookOpenText,
  capture: Sparkles,
  companion: MessageCircle,
  notebook: BookOpenText,
  orbit: Orbit,
  profile: UserRoundCog,
  search: Search,
  settings: Gauge,
  target: Sparkles,
});
