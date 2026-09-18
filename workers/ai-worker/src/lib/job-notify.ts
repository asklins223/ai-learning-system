/**
 * P4-6: Notify 唤醒通道(实施计划 §5.4)。
 *
 * LISTEN/NOTIFY 唤醒:job 状态变化时数据库通过 pg_notify 在
 * 'ailearn_job_events' 频道发送通知,worker 的 LISTEN 消费者收到通知后立即
 * 领取,无需空轮询。NOTIFY 的发送方是 SQL 函数(见 apps/api 迁移
 * 0115_job_insert_notify.sql),worker 只消费。
 */

export const NOTIFY_CHANNEL = "ailearn_job_events";
