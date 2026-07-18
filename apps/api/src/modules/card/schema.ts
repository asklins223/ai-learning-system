import { z } from "zod";

export const generateCardRequestSchema = z.object({
  noteVersionId: z.string().uuid(),
});

export type GenerateCardResponse = {
  jobId: string;
};
