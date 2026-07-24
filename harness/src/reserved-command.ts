import { RESERVED_SKILL_COMMANDS, type ReservedSkillCommand } from "./repository-contract.js";

export function rejectReservedCommand(command: ReservedSkillCommand): never {
  const plannedSlice = RESERVED_SKILL_COMMANDS[command];
  process.stderr.write(
    `${JSON.stringify({
      schemaVersion: "startup_opportunity.reserved_command.v1",
      command,
      status: "unavailable",
      reason: "not_implemented_in_g0.4",
      plannedSlice,
    })}\n`,
  );
  process.exit(2);
}
