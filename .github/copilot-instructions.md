# Copilot Instructions for Discord Multiplayer Game Project

## Project Architecture

This is a multiplayer Flappy Bird game built for Discord using the following key technologies:
- Phaser 3 (game engine)
- Colyseus (multiplayer server framework)
- Discord Embedded App SDK
- TypeScript
- Vite (bundler)

### Key Components

1. **Client (`packages/client/`)**
   - Main game logic in `src/scenes/`
   - Asset management in `public/assets/`
   - Discord SDK integration in `src/utils/discordSDK.ts`

2. **Server (`packages/server/`)**
   - Colyseus room management in `rooms/GameRoom.ts`
   - Game state synchronization in `schemas/GameState.ts`
   - WebSocket server in `server.ts`

## Development Workflow

### Setup and Running
```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev

# Build for production
pnpm build
```

### Key Patterns

1. **Game State Management**
   - All shared game state is defined in `server/schemas/GameState.ts`
   - Client subscribes to state changes through Colyseus
   - Example: `GameRoom.ts` manages player states and pipe spawning

2. **Scene Structure**
   - Each game phase is a separate scene (Boot → Preloader → MainMenu → Game)
   - Use `XScene` base class from `utils/XScene.ts` for common functionality

3. **Asset Management**
   - Assets loaded through Vite's static file handling
   - Use explicit imports for bundled assets
   - Place static files in `client/public/assets/`

4. **Multiplayer Synchronization**
   - Server is authoritative for game state
   - Use `GameRoom.ts` methods for game logic
   - State schema defines synchronized properties

## Common Tasks

1. **Adding Game Features**
   - Define state in `GameState.ts`
   - Implement logic in `GameRoom.ts`
   - Add client-side rendering in appropriate scene

2. **Managing Assets**
   - Add assets to `client/public/assets/`
   - Load in `Preloader.ts` scene
   - Reference using asset path: `assets/yourfile.png`

## Project-Specific Conventions

1. **Scaling and Responsiveness**
   - Use `ScaleFlow.ts` utility for responsive layout
   - Base resolution: 1280x720

2. **Game Configuration**
   - Game settings defined at the top of `GameRoom.ts`
   - Example: `gravity`, `pipeSpeed`, `maxClients`

3. **Debug Logging**
   - Use the `logger` utility from `server/logger.ts`
   - Important for multiplayer state debugging