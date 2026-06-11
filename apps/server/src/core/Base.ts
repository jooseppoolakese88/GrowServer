import { Client } from "growtopia.js";
import {
  downloadMkcert,
  setupMkcert,
  checkPortInUse,
  downloadWebsite,
  setupWebsite,
  downloadItemsDat,
  downloadMacOSItemsDat,
  fetchJSON,
  Collection,
  RTTEX,
} from "@growserver/utils";
import { join } from "path";
import { ConnectListener } from "../events/Connect";
import { DisconnectListener } from "../events/Disconnect";
import { type PackageJson } from "type-fest";
import { RawListener } from "../events/Raw";
import { readFileSync } from "fs";
import {
  Cache,
  CDNContent,
  CustomItemsConfig,
  ItemsData,
  ItemsInfo,
} from "@growserver/types";
import { ItemDefinition } from "grow-items";
import { Database } from "@growserver/db";
import { Peer } from "./Peer";
import { World } from "./World";
import { mkdir, writeFile, readFile } from "fs/promises";
import chokidar from "chokidar";
import ky from "ky";
import { ITEMS_DAT_FETCH_URL } from "@growserver/const";
import { ItemsDat, ItemsDatMeta } from "grow-items";
import { config as configServer } from "@growserver/config";
import logger from "@growserver/logger";
import { createServer } from "http";
import { createReadStream, existsSync } from "fs";
import { extname } from "path";


__dirname = process.cwd();

export class Base {
  public server: Client;
  public items: ItemsData;
  public package: PackageJson;
  public config;
  public cdn: CDNContent;
  public cache: Cache;
  public database: Database;

  constructor() {
    this.server = new Client({
      enet: {
        ip:                 "0.0.0.0",
        useNewServerPacket: true,
      },
    });
    this.package = JSON.parse(
      readFileSync(join(__dirname, "package.json"), "utf-8"),
    );
    this.config = configServer;
    this.cdn = { version: "", uri: "0000/0000", itemsDatName: "" };
    this.items = {
      content:  Buffer.alloc(0),
      hash:     "",
      metadata: {} as ItemsDatMeta,
      wiki:     [],
    };
    this.cache = {
      peers:    new Collection(),
      worlds:   new Collection(),
      cooldown: new Collection(),
    };

    this.database = new Database();
  }

  public async start() {
    try {
      logger.info(
        `GrowServer | Version: ${this.package.version} | Copyright JadlionHD 2022-${new Date().getFullYear()}`,
      );

      // Check if port is available
      const port = this.server.config.enet?.port || 17091;
      const portInUse = await checkPortInUse(port);

      if (portInUse) {
        throw new Error(
          `Port ${port} is already in use. Please choose a different port.`,
        );
      }
      

      
      this.cdn = {
        version: "5.48",
        uri: "http://127.0.0.1:8088",
        itemsDatName: "items-v5.48.dat"
      };
      //this.cdn = await this.getLatestCdn();
      if (!this.cdn.itemsDatName) {
        this.cdn.itemsDatName = "items-v5.48.dat";
        logger.warn("CDN unavailable, falling back to local items-v5.48.dat");
      }

      logger.info(`Parsing ${this.cdn.itemsDatName}`);
      const datDir = join(__dirname, ".cache", "growtopia", "dat");
      const datName = join(datDir, this.cdn.itemsDatName);
      const itemsDat = readFileSync(datName);

      this.items = {
        hash:     `${RTTEX.hash(itemsDat)}`,
        content:  itemsDat,
        metadata: {} as ItemsDatMeta,
        wiki:     [] as ItemsInfo[],
      };
      
      await this.startFileServer();

      logger.info(`Starting ENet server on port ${port}`);

      // Add error handling for server start
      await new Promise((resolve, reject) => {
        try {
          this.server.listen();
          resolve(true);
        } catch (err) {
          reject(err);
        }
      });

      await this.loadItems();
      logger.info(`Total items loaded: ${this.items.metadata.items.size}`);
      logger.info(`Item 8 exists: ${!!this.items.metadata.items.get(8)}`);
      logger.info(`Item 2 exists: ${!!this.items.metadata.items.get(2)}`);
      await this.loadEvents();
    } catch (err) {
      logger.error(`Failed to start server: ${err}`);
      process.exit(1);
    }
  }

  private async startFileServer() {
    const cacheDir = join(__dirname, ".cache");
    

    const server = createServer((req, res) => {
      const filePath = join(cacheDir, req.url || "");

      if (!existsSync(filePath)) {
        logger.warn(`File server 404: ${req.url}`);
        res.writeHead(404);
        res.end("Not found");
        return;
      }


      logger.info(`File server 200: ${req.url}`)
      // Set correct mime type for .dat files
      const ext = extname(filePath);
      const mime: Record<string, string> = {
        ".dat": "application/octet-stream",
        ".html": "text/html",
        ".js":  "application/javascript",
      };

      res.writeHead(200, { "Content-Type": mime[ext] || "application/octet-stream" });
      createReadStream(filePath).pipe(res);
    });

    await new Promise<void>((resolve) => server.listen(8088, "127.0.0.1", resolve));
    logger.info("File server running on http://127.0.0.1:8088");
  }

  private async loadEvents() {
    const connect = new ConnectListener(this);
    const disconnect = new DisconnectListener(this);
    const raw = new RawListener(this);

    this.server.on("connect", (netID) => connect.run(netID));
    this.server.on("disconnect", (netID) => disconnect.run(netID));
    this.server.on("raw", (netID, channelID, data) =>
      raw.run(netID, channelID, data),
    );

    // Register command aliases after server has started
    this.registerCommandAliases();

    // Check items-config.json file changes
    chokidar
      .watch(join(__dirname, "assets", "custom-items"), { persistent: true })
      .on("change", async (path) => {
        const pathArr = path.split("\\");
        const fileName = pathArr[pathArr.length - 1];
        chokidar
          .watch(join(__dirname, "assets", "custom-items"), {
            persistent: true,
          })
          .on("change", async (path) => {
            const pathArr = path.split("\\");
            const fileName = pathArr[pathArr.length - 1];

            logger.info(
              `Detected custom-items directory changes | ${fileName}`,
            );
            logger.info(`Refreshing items data`);
            await this.loadItems();
          });
        logger.info(`Detected custom-items directory changes | ${fileName}`);
        logger.info(`Refreshing items data`);
        await this.loadItems();
      });
  }

  // Register command aliases after server initialization
  private async registerCommandAliases() {
    try {
      const { registerAliases } = await import("../command/cmds/index");
      await registerAliases();
      logger.info("Command aliases registered successfully");
    } catch (error) {
      logger.error("Failed to register command aliases");
    }
  }

  private async loadItems() {
    const itemsDat = new ItemsDat(
      Array.from(
        await readFile(
          join(__dirname, ".cache", "growtopia", "dat", this.cdn.itemsDatName),
        ),
      ),
    );
    await itemsDat.decode();
    logger.info(`Items decoded: ${itemsDat.meta.items.size}`);
    const firstItem = [...itemsDat.meta.items.entries()][0];
    logger.info(`First item: ${JSON.stringify(firstItem)}`);
    // logger.info("Loading custom items...");

    // Disable temporarily (TODO: remaking this later)
    // try {
    //   const itemsConf = JSON.parse(
    //     await readFile(
    //       join(__dirname, "assets", "custom-items", "items-config.json"),
    //       "utf-8"
    //     )
    //   ) as CustomItemsConfig;

    //   for (const asset of itemsConf.assets) {
    //     if (!asset.id) throw "Item ID are required to replace specific item";

    //     const item = itemsDat.meta.items.get(asset.id)!;

    //     consola.start(`Modifying item ID: ${item.id} | ${item.name}`);

    //     Object.assign(item, {
    //       ...asset.item,
    //     });

    //     if (asset.item.extraFile) {
    //       const image = await readFile(
    //         join(
    //           __dirname,
    //           "assets",
    //           "custom-items",
    //           asset.item.extraFile.pathAsset
    //         )
    //       );
    //       const rttex = await RTTEX.encode(image);

    //       item.extraFile = asset.item.extraFile.pathResult;
    //       item.extraFileHash = RTTEX.hash(rttex);

    //       await mkdir(
    //         join(__dirname, ".cache", "growtopia", "cache", asset.storePath),
    //         {
    //           recursive: true,
    //         }
    //       );
    //       await writeFile(
    //         join(
    //           __dirname,
    //           ".cache",
    //           "growtopia",
    //           "cache",
    //           asset.storePath,
    //           asset.item.extraFile.fileName
    //         ),
    //         rttex,
    //         {
    //           flush: true,
    //         }
    //       );
    //     }

    //     if (asset.item.texture) {
    //       const image = await readFile(
    //         join(
    //           __dirname,
    //           "assets",
    //           "custom-items",
    //           asset.item.texture.pathAsset
    //         )
    //       );
    //       const rttex = await RTTEX.encode(image);

    //       item.texture = asset.item.texture.pathResult;
    //       item.textureHash = RTTEX.hash(rttex);

    //       await mkdir(
    //         join(__dirname, ".cache", "growtopia", "cache", asset.storePath),
    //         {
    //           recursive: true,
    //         }
    //       );
    //       await writeFile(
    //         join(
    //           __dirname,
    //           ".cache",
    //           "growtopia",
    //           "cache",
    //           asset.storePath,
    //           asset.item.texture.fileName
    //         ),
    //         rttex,
    //         {
    //           flush: true,
    //         }
    //       );
    //     }

    //     consola.success(
    //       `Successfully modifying item ID: ${item.id} | ${item.name}`
    //     );
    //   }
    // } catch (e) {
    //   consola.error("Failed to load custom items: " + e);
    // }


    const rawDat = await readFile(
      join(__dirname, ".cache", "growtopia", "dat", this.cdn.itemsDatName)
    );
    const bufData = rawDat;
    const hash = RTTEX.hash(bufData);
    this.items.content = bufData;
    this.items.hash = `${hash}`;
    this.items.metadata = itemsDat.meta;

    const wikiFile = await readFile(
      join(__dirname, "assets", "items_info_new.json"),
      "utf-8",
    );
    this.items.wiki = JSON.parse(wikiFile) as ItemsInfo[];

    logger.info(`Items data hash: ${hash}`);
    logger.info("Successfully parsing items data");
  }

  public async getLatestCdn() {
    try {
      const cdnData = (await fetchJSON(
        "https://mari-project.jad.li/api/v1/growtopia/cache/latest",
      )) as CDNContent;
      const itemsDat = (await fetchJSON(ITEMS_DAT_FETCH_URL)) as {
        content: string;
      };

      const data: CDNContent = {
        version:      cdnData.version,
        uri:          "http://127.0.0.1",
        itemsDatName: itemsDat.content,
      };

      return data;
    } catch (e) {
      logger.error(`Failed to get latest CDN: ${e}`);
      return { version: "", uri: "", itemsDatName: "" };
    }
  }

  public getItem(id: number): ItemDefinition | undefined {
  return this.items.metadata.items.get(id as any);
}

  public async saveAll(disconnectAll = false): Promise<boolean> {
    logger.info(
      `Saving ${this.cache.peers.size} peers & ${this.cache.worlds.size} worlds`,
    );

    const worldsSaved = await this.saveWorlds();
    const playersSaved = await this.savePlayers(disconnectAll);

    return worldsSaved && playersSaved;
  }

  public async saveWorlds() {
    try {
      let savedCount = 0;
      for (const [, world] of this.cache.worlds) {
        const wrld = new World(this, world.name);
        if (typeof wrld.worldName === "string")
          await wrld.saveToDatabase().catch((e) => logger.error(e));
        else
          logger.warn(
            `Oh no there's undefined (${savedCount}) world, skipping..`,
          );
        savedCount++;
      }
      logger.info(`Saved ${savedCount} worlds`);
      return true;
    } catch (err) {
      logger.error(`Failed to save worlds: ${err}`);
      return false;
    }
  }

  public async savePlayers(disconenctAll: boolean) {
    try {
      let savedCount = 0;
      for (const [, peer] of this.cache.peers) {
        const player = new Peer(this, peer.netID);
        await player.saveToDatabase();
        if (disconenctAll) {
          player.disconnect("now");
        }
        savedCount++;
      }
      logger.info(`Saved ${savedCount} players`);
      return true;
    } catch (err) {
      logger.error(`Failed to save players: ${err}`);
      return false;
    }
  }

  // Added from your updated version (version 2)
  public getPlayersOnline(ignoredNetIDs: number[] = [0]): number {
    if (!this.cache.peers || this.cache.peers.size === 0) {
      return 0;
    }

    let playerCount = 0;
    this.cache.peers.forEach((peerData, netID) => {
      if (!ignoredNetIDs.includes(netID)) {
        playerCount++;
      }
    });
    return playerCount;
  }

  public async shutdown() {
    logger.info("Shutting down server...");
    await this.saveAll(true);
    process.exit(0);
  }
}
