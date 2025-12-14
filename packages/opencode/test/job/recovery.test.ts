/**
 * Job Recovery and Cascade Delete Tests - Phase 7
 *
 * Tests for:
 * - Job.recoverOrphanedJobs() - recovering jobs stuck in running/pending after crash
 * - Session cascade delete - removing jobs when session is deleted
 *
 * NOTE: These tests require mocking SessionPrompt to avoid circular import issues.
 */
import { describe, expect, test, mock } from "bun:test"
import path from "node:path"
import { Instance } from "../../src/project/instance"

// Mock modules before dynamic imports
mock.module("@/session/prompt", () => ({
  SessionPrompt: {
    cancel() {},
    async prompt() {
      return { parts: [] }
    },
    async resolvePromptParts() {
      return []
    },
  },
}))

mock.module("@/agent/agent", () => ({
  Agent: {
    async get() {
      return { name: "test", mode: "subagent" }
    },
    async list() {
      return []
    },
  },
}))

// Dynamic imports after mocks are set up
const { Job } = await import("../../src/job")
const { Session } = await import("../../src/session")
const { Storage } = await import("../../src/storage/storage")
const { Identifier } = await import("../../src/id/id")

const projectRoot = path.join(__dirname, "../..")

async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
  return Instance.provide({ directory: projectRoot, fn })
}

describe("Job.recoverOrphanedJobs", () => {
  test("marks orphaned running jobs as error", async () => {
    await withInstance(async () => {
      // Create a job directly in storage with "running" status (simulating crash)
      const jobID = Identifier.descending("job")
      const projectID = Instance.project.id

      await Storage.write(["job", projectID, jobID], {
        id: jobID,
        projectID,
        type: "test",
        title: "Orphaned job",
        status: "running",
        params: {},
        time: {
          created: Date.now(),
          updated: Date.now(),
          started: Date.now(),
        },
      })

      // Run recovery
      const recovered = await Job.recoverOrphanedJobs()

      // Verify job was recovered
      expect(recovered).toBeGreaterThanOrEqual(1)

      // Verify job status changed to error
      const job = await Job.get(jobID)
      expect(job.status).toBe("error")
      expect(job.error).toBe("Job interrupted by application restart")

      // Cleanup
      await Job.remove(jobID)
    })
  })

  test("marks orphaned pending jobs as error", async () => {
    await withInstance(async () => {
      const jobID = Identifier.descending("job")
      const projectID = Instance.project.id

      await Storage.write(["job", projectID, jobID], {
        id: jobID,
        projectID,
        type: "test",
        title: "Orphaned pending job",
        status: "pending",
        params: {},
        time: {
          created: Date.now(),
          updated: Date.now(),
        },
      })

      const recovered = await Job.recoverOrphanedJobs()
      expect(recovered).toBeGreaterThanOrEqual(1)

      const job = await Job.get(jobID)
      expect(job.status).toBe("error")
      expect(job.time.completed).toBeDefined()

      await Job.remove(jobID)
    })
  })

  test("does not affect already terminal jobs", async () => {
    await withInstance(async () => {
      const jobID = Identifier.descending("job")
      const projectID = Instance.project.id

      await Storage.write(["job", projectID, jobID], {
        id: jobID,
        projectID,
        type: "test",
        title: "Completed job",
        status: "completed",
        params: {},
        time: {
          created: Date.now(),
          updated: Date.now(),
          completed: Date.now(),
        },
      })

      await Job.recoverOrphanedJobs()

      const job = await Job.get(jobID)
      expect(job.status).toBe("completed")

      await Job.remove(jobID)
    })
  })

  test("recovers jobs of all types", async () => {
    await withInstance(async () => {
      const projectID = Instance.project.id
      const now = Date.now()

      // Create orphaned jobs of different types
      const subagentJobID = Identifier.descending("job")
      await Storage.write(["job", projectID, subagentJobID], {
        id: subagentJobID,
        projectID,
        type: "subagent",
        title: "Orphaned subagent job",
        status: "running",
        params: {},
        time: { created: now, updated: now, started: now },
      })

      const customJobID = Identifier.descending("job")
      await Storage.write(["job", projectID, customJobID], {
        id: customJobID,
        projectID,
        type: "custom_type",
        title: "Orphaned custom job",
        status: "running",
        params: {},
        time: { created: now, updated: now, started: now },
      })

      const recovered = await Job.recoverOrphanedJobs()
      expect(recovered).toBeGreaterThanOrEqual(2)

      // Both jobs should be recovered regardless of type
      const subagentJob = await Job.get(subagentJobID)
      expect(subagentJob.status).toBe("error")

      const customJob = await Job.get(customJobID)
      expect(customJob.status).toBe("error")

      await Job.remove(subagentJobID)
      await Job.remove(customJobID)
    })
  })

  test("adds recoveredAt timestamp to metadata", async () => {
    await withInstance(async () => {
      const jobID = Identifier.descending("job")
      const projectID = Instance.project.id

      await Storage.write(["job", projectID, jobID], {
        id: jobID,
        projectID,
        type: "test",
        title: "Orphaned job",
        status: "running",
        params: {},
        time: {
          created: Date.now(),
          updated: Date.now(),
          started: Date.now(),
        },
      })

      await Job.recoverOrphanedJobs()

      const job = await Job.get(jobID)
      expect(job.metadata?.recoveredAt).toBeDefined()
      expect(typeof job.metadata?.recoveredAt).toBe("number")

      await Job.remove(jobID)
    })
  })
})

describe("Session cascade delete", () => {
  test("removes jobs when session is deleted", async () => {
    await withInstance(async () => {
      // Create a session
      const session = await Session.create({ title: "Test Session" })
      const projectID = Instance.project.id

      // Create a job associated with this session
      const jobID = Identifier.descending("job")
      await Storage.write(["job", projectID, jobID], {
        id: jobID,
        projectID,
        type: "test",
        title: "Job for session",
        parentSessionID: session.id,
        status: "completed",
        params: {},
        time: {
          created: Date.now(),
          updated: Date.now(),
          completed: Date.now(),
        },
      })

      // Verify job exists
      const jobBefore = await Job.get(jobID)
      expect(jobBefore.parentSessionID).toBe(session.id)

      // Remove session
      await Session.remove(session.id)

      // Verify job was also removed
      await expect(Job.get(jobID)).rejects.toThrow(Job.NotFoundError)
    })
  })

  test("removes multiple jobs when session is deleted", async () => {
    await withInstance(async () => {
      const session = await Session.create({ title: "Test Session" })
      const projectID = Instance.project.id

      // Create multiple jobs for this session
      const jobIDs: string[] = []
      for (let i = 0; i < 3; i++) {
        const jobID = Identifier.descending("job")
        jobIDs.push(jobID)
        await Storage.write(["job", projectID, jobID], {
          id: jobID,
          projectID,
          type: "test",
          title: `Job ${i}`,
          parentSessionID: session.id,
          status: "completed",
          params: {},
          time: {
            created: Date.now(),
            updated: Date.now(),
            completed: Date.now(),
          },
        })
      }

      // Remove session
      await Session.remove(session.id)

      // Verify all jobs were removed
      for (const jobID of jobIDs) {
        await expect(Job.get(jobID)).rejects.toThrow(Job.NotFoundError)
      }
    })
  })

  test("does not remove jobs from other sessions", async () => {
    await withInstance(async () => {
      const session1 = await Session.create({ title: "Session 1" })
      const session2 = await Session.create({ title: "Session 2" })
      const projectID = Instance.project.id

      // Create job for session 1
      const job1ID = Identifier.descending("job")
      await Storage.write(["job", projectID, job1ID], {
        id: job1ID,
        projectID,
        type: "test",
        title: "Job for session 1",
        parentSessionID: session1.id,
        status: "completed",
        params: {},
        time: {
          created: Date.now(),
          updated: Date.now(),
          completed: Date.now(),
        },
      })

      // Create job for session 2
      const job2ID = Identifier.descending("job")
      await Storage.write(["job", projectID, job2ID], {
        id: job2ID,
        projectID,
        type: "test",
        title: "Job for session 2",
        parentSessionID: session2.id,
        status: "completed",
        params: {},
        time: {
          created: Date.now(),
          updated: Date.now(),
          completed: Date.now(),
        },
      })

      // Remove session 1 only
      await Session.remove(session1.id)

      // Verify job1 was removed but job2 still exists
      await expect(Job.get(job1ID)).rejects.toThrow(Job.NotFoundError)
      const job2 = await Job.get(job2ID)
      expect(job2.parentSessionID).toBe(session2.id)

      // Cleanup
      await Session.remove(session2.id)
    })
  })

  test("cascade delete is best-effort", async () => {
    await withInstance(async () => {
      const session = await Session.create({ title: "Test Session" })

      // Session remove should succeed even if there are no jobs or
      // job removal fails silently - this just verifies no exception is thrown
      await Session.remove(session.id)
    })
  })
})
