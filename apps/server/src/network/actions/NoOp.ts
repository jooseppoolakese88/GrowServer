import { Base } from "../../core/Base";
import { Peer } from "../../core/Peer";

export class NoOp {
  constructor(
    public base: Base,
    public peer: Peer,
  ) {}

  public async execute(action: Record<string, string>): Promise<void> {
    // Not implemented yet
  }
}