import { Base } from "../../core/Base";
import { Peer } from "../../core/Peer";

export class WrenchEnd {
  constructor(
    public base: Base,
    public peer: Peer,
    public action: Record<string, string>,
  ) {}

  public async execute(): Promise<void> {
    // No-op: wrench dialog closed
  }
}