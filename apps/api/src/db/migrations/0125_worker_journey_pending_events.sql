-- 0125: worker 写 Journey pending 事件（P6 里程碑跨进程）。
--
-- learning_cards / evidences 由 ai-worker（publish-phase）创建；worker 只能
-- 以 (journeyId, domainEventId) 幂等写 companion_journey_pending_events（INSERT），
-- 不得推进 journeys 本身——JourneyReducer 仍在 API 进程（drain 消费）。

--> statement-breakpoint

GRANT INSERT ON public.companion_journey_pending_events TO ailearn_worker;
