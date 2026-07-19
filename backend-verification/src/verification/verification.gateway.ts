import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger, forwardRef, Inject } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { NotificationService } from './notification.service';
import { QrService } from './qr.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JoinSessionPayload {
  sessionId: string;
  userId?: string;
}

interface JoinSimulatorPayload {
  userId: string;   // used as the simulator room key
  sessionId?: string;
}

interface SimulatorAlertPayload {
  sessionId: string;
  userId: string;
  words: string[];          // 5 words displayed on the login screen
  type: 'word_game' | 'approve_deny' | 'qr';
  qrUrl?: string;
}

// ---------------------------------------------------------------------------
// Room naming helpers — keeps room keys consistent across the gateway
// ---------------------------------------------------------------------------

const sessionRoom   = (sessionId: string) => `session:${sessionId}`;
const simulatorRoom = (userId: string)    => `simulator:${userId}`;

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

@WebSocketGateway({
  cors: {
    origin: [
      process.env.FRONTEND_URL  ?? 'http://localhost:5173',
      process.env.AUTH_SERVER_URL ?? 'http://localhost:3001',
      'http://localhost:3002', // Simulator page (served from same port)
      'http://localhost:3000', // Auth server dashboard (if needed)
    ],
    methods: ['GET', 'POST'],
    credentials: true,
  },
  namespace: '/',
  transports: ['websocket', 'polling'],
})
export class VerificationGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  private readonly server: Server;

  private readonly logger = new Logger(VerificationGateway.name);

  /**
   * Maps userId → Set<socketId> for simulator connections.
   * A user might have the simulator open in multiple tabs.
   */
  private readonly simulatorSockets = new Map<string, Set<string>>();

  /**
   * Maps socketId → { userId, sessionId } for cleanup on disconnect.
   */
  private readonly socketMeta = new Map<
    string,
    { type: 'session' | 'simulator'; id: string }
  >();

  constructor(
    @Inject(forwardRef(() => NotificationService))
    private readonly notificationService: NotificationService,

    @Inject(forwardRef(() => QrService))
    private readonly qrService: QrService,
  ) {}

  // -------------------------------------------------------------------------
  // Lifecycle hooks
  // -------------------------------------------------------------------------

  afterInit(server: Server) {
    this.logger.log('✅  VerificationGateway initialised — Socket.IO server ready.');
  }

  handleConnection(client: Socket) {
    this.logger.log(`[Connect]  socket=${client.id}  ip=${client.handshake.address}`);
  }

  handleDisconnect(client: Socket) {
    const meta = this.socketMeta.get(client.id);
    if (meta) {
      if (meta.type === 'simulator') {
        const sockets = this.simulatorSockets.get(meta.id);
        if (sockets) {
          sockets.delete(client.id);
          if (sockets.size === 0) this.simulatorSockets.delete(meta.id);
        }
        this.logger.log(`[Disconnect] Simulator for userId=${meta.id} — socket=${client.id}`);
      } else {
        this.logger.log(`[Disconnect] Session room=${meta.id} — socket=${client.id}`);
      }
      this.socketMeta.delete(client.id);
    } else {
      this.logger.log(`[Disconnect] Unregistered socket=${client.id}`);
    }
  }

  // -------------------------------------------------------------------------
  // Inbound events — Login browser
  // -------------------------------------------------------------------------

  /**
   * `join_session`
   * The logging-in browser emits this immediately after page load.
   * It joins a private room keyed by sessionId so the server can push
   * verification results back to exactly this browser tab.
   *
   * Payload: { sessionId: string, userId?: string }
   */
  @SubscribeMessage('join_session')
  handleJoinSession(
    @MessageBody() payload: JoinSessionPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const { sessionId, userId } = payload;

    if (!sessionId) {
      client.emit('error', { message: 'join_session requires a sessionId.' });
      return;
    }

    const room = sessionRoom(sessionId);
    client.join(room);
    this.socketMeta.set(client.id, { type: 'session', id: sessionId });

    this.logger.log(
      `[join_session] socket=${client.id}  sessionId=${sessionId}  userId=${userId ?? 'anonymous'}`,
    );

    client.emit('session_joined', {
      sessionId,
      message: 'Joined session room. Waiting for trusted device approval.',
    });
  }

  // -------------------------------------------------------------------------
  // Inbound events — Trusted Device Simulator
  // -------------------------------------------------------------------------

  /**
   * `join_simulator`
   * The trusted device simulator emits this on load.
   * It joins a room keyed by userId so the server can push
   * verification requests to the right simulator instance.
   *
   * Payload: { userId: string, sessionId?: string }
   */
  @SubscribeMessage('join_simulator')
  handleJoinSimulator(
    @MessageBody() payload: JoinSimulatorPayload,
    @ConnectedSocket() client: Socket,
  ) {
    const { userId, sessionId } = payload;

    if (!userId) {
      client.emit('error', { message: 'join_simulator requires a userId.' });
      return;
    }

    const room = simulatorRoom(userId);
    client.join(room);
    this.socketMeta.set(client.id, { type: 'simulator', id: userId });

    // Track socket IDs for this user
    if (!this.simulatorSockets.has(userId)) {
      this.simulatorSockets.set(userId, new Set());
    }
    this.simulatorSockets.get(userId)!.add(client.id);

    this.logger.log(
      `[join_simulator] socket=${client.id}  userId=${userId}  sessionId=${sessionId ?? 'none'}`,
    );

    client.emit('simulator_joined', {
      userId,
      message: 'Simulator registered. Listening for push alerts.',
    });
  }

  /**
   * `simulator_approve`
   * The simulator user clicks "Approve" (simple approve/deny flow).
   *
   * Payload: { sessionId: string }
   */
  @SubscribeMessage('simulator_approve')
  handleSimulatorApprove(
    @MessageBody() payload: { sessionId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { sessionId } = payload;
    this.logger.log(`[simulator_approve] sessionId=${sessionId}`);

    // Notify the login browser
    this.notifySessionApproved(sessionId, []);
  }

  /**
   * `simulator_reject`
   * The simulator user clicks "Deny".
   *
   * Payload: { sessionId: string }
   */
  @SubscribeMessage('simulator_reject')
  handleSimulatorReject(
    @MessageBody() payload: { sessionId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const { sessionId } = payload;
    this.logger.log(`[simulator_reject] sessionId=${sessionId}`);
    this.notificationService.rejectSession(sessionId);
  }

  /**
   * `submit_word_verification`
   * The simulator user submits their 2 chosen words.
   *
   * Payload: { sessionId: string, chosenWords: string[] }
   */
  @SubscribeMessage('submit_word_verification')
  handleWordVerification(
    @MessageBody() payload: { sessionId: string; chosenWords: string[] },
    @ConnectedSocket() client: Socket,
  ) {
    const { sessionId, chosenWords } = payload;
    this.logger.log(
      `[submit_word_verification] sessionId=${sessionId}  words=[${chosenWords?.join(', ')}]`,
    );

    const result = this.notificationService.submitDeviceVerification(
      sessionId,
      chosenWords,
    );

    // Echo result back to the simulator so its UI can update
    client.emit('word_verification_result', result);
  }

  // -------------------------------------------------------------------------
  // Outbound — called by NotificationService & QrService
  // -------------------------------------------------------------------------

  /**
   * Pushes a verification request (with the 5 words) to the user's simulator.
   * Also pushes approval status back to the login page.
   *
   * @param userId    The user whose simulator should receive the alert.
   * @param sessionId The login session that needs approval.
   */
  pushNotificationAlert(
    userId: string,
    sessionId: string,
    words: string[],
    type: 'word_game' | 'approve_deny' | 'qr' = 'word_game',
    qrUrl?: string,
  ): void {
    const room = simulatorRoom(userId);
    const payload: SimulatorAlertPayload = {
      sessionId,
      userId,
      words,
      type,
      qrUrl,
    };

    this.server.to(room).emit('notification_request', payload);

    this.logger.log(
      `[pushNotificationAlert] → simulator room=${room}  sessionId=${sessionId}  type=${type}  words=[${words.join(', ')}]`,
    );
  }

  /**
   * Emits `verification_complete` to the login browser's session room.
   * The browser reacts by redirecting the user to the dashboard.
   *
   * @param sessionId The login session that has been approved.
   * @param token     A short-lived JWT the browser can exchange for a full session.
   */
  notifyBrowserSuccess(sessionId: string, token: string): void {
    const room = sessionRoom(sessionId);

    this.server.to(room).emit('verification_complete', {
      sessionId,
      token,
      approvedAt: new Date().toISOString(),
      message: 'Verification successful. Redirecting to dashboard.',
    });

    this.logger.log(`[notifyBrowserSuccess] → session room=${room}  sessionId=${sessionId}`);
  }

  /**
   * Emits `verification_approved` to the login browser's session room.
   * Called internally after word-game or QR approval.
   */
  notifySessionApproved(sessionId: string, words: string[]): void {
    const room = sessionRoom(sessionId);

    this.server.to(room).emit('verification_approved', {
      sessionId,
      words,
      approvedAt: new Date().toISOString(),
      message: 'Trusted device approved the login request.',
    });

    this.logger.log(`[notifySessionApproved] → session room=${room}`);
  }

  /**
   * Emits `verification_rejected` to the login browser's session room.
   */
  notifySessionRejected(sessionId: string): void {
    const room = sessionRoom(sessionId);

    this.server.to(room).emit('verification_rejected', {
      sessionId,
      rejectedAt: new Date().toISOString(),
      message: 'Trusted device rejected the login request.',
    });

    this.logger.log(`[notifySessionRejected] → session room=${room}`);
  }

  /**
   * Emits `verification_expired` to the login browser's session room.
   * Used when a QR code or word-game session times out.
   */
  notifySessionExpired(sessionId: string): void {
    const room = sessionRoom(sessionId);

    this.server.to(room).emit('verification_expired', {
      sessionId,
      expiredAt: new Date().toISOString(),
      message: 'Verification session expired. Please try again.',
    });

    this.logger.log(`[notifySessionExpired] → session room=${room}`);
  }

  // -------------------------------------------------------------------------
  // Utility
  // -------------------------------------------------------------------------

  /** Returns true if at least one simulator socket is online for the userId. */
  isSimulatorOnline(userId: string): boolean {
    const sockets = this.simulatorSockets.get(userId);
    return !!sockets && sockets.size > 0;
  }
}
