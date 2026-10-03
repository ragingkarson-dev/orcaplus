import { GroupMotor, Spring } from "@rbxts/flipper";
import { Players, RunService, UserInputService, Workspace } from "@rbxts/services";
import { onJobChange, trackCleanup, trackConnection } from "jobs/helpers/job-store";

const player = Players.LocalPlayer;

// Input direction vectors, keyed by name so we can reset cleanly.
const moveDirection = {
	forward: new Vector3(),
	backward: new Vector3(),
	left: new Vector3(),
	right: new Vector3(),
	up: new Vector3(),
	down: new Vector3(),
};

// Flight state
let enabled = false;
let speed = 16;
const ACCELERATION = 3.5;      // how fast you reach top speed (lower = floatier)
const DECELERATION = 4.5;      // how fast you glide to a stop (lower = more drift)

// Physics
let humanoidRoot: BasePart | undefined;
let velocity = new Vector3();  // current world-space velocity (studs/sec)
let coordinateSpring = new GroupMotor([0, 0, 0], false);

// The base position we're flying from — springs interpolate toward this.
let targetPosition = new Vector3();

// Flight pose
let humanoid: Humanoid | undefined;
let originalHipHeight: number | undefined;
let flyAnimationTrack: AnimationTrack | undefined;

const FLY_ANIMATION_ID = "rbxassetid://3547741619"; // fallback flying pose
// If you have a custom animation, replace the ID above.

async function main() {
	trackCleanup(() => {
		enabled = false;
		humanoidRoot = undefined;
		humanoid = undefined;
		velocity = new Vector3();
		resetDirection();
		restorePose();
	});

	await onJobChange("flight", async (job) => {
		enabled = job.active;
		speed = job.value;
		if (enabled) {
			cacheCharacterRefs();
			resetCoordinate();
			resetSpring();
		} else {
			restorePose();
		}
	});

	trackConnection(
		UserInputService.InputBegan.Connect((input, gameProcessed) => {
			if (gameProcessed) return;
			updateDirection(input.KeyCode, true);
		}),
	);

	trackConnection(
		UserInputService.InputEnded.Connect((input) => {
			updateDirection(input.KeyCode, false);
		}),
	);

	trackConnection(
		RunService.Heartbeat.Connect((deltaTime) => {
			if (!enabled || !humanoidRoot) return;

			stepVelocity(deltaTime);
			stepPosition(deltaTime);

			// Zero out Roblox physics so we're the only thing moving us.
			humanoidRoot.AssemblyLinearVelocity = new Vector3();
			humanoidRoot.AssemblyAngularVelocity = new Vector3();

			// Apply the spring-smoothed position. We only override position,
			// never break joints, so the server still sees a normal character.
			humanoidRoot.CFrame = new CFrame(targetPosition)
				.mul(Workspace.CurrentCamera!.CFrame.Rotation);
		}),
	);

	// Keep the body oriented with the camera (like Superman facing where you look).
	trackConnection(
		RunService.RenderStepped.Connect(() => {
			if (!enabled || !humanoidRoot) return;
			// Re-apply rotation each frame so mouse movement feels responsive.
			humanoidRoot.CFrame = new CFrame(humanoidRoot.Position)
				.mul(Workspace.CurrentCamera!.CFrame.Rotation);
		}),
	);

	trackConnection(
		player.CharacterAdded.Connect((character) => {
			const newRoot = character.WaitForChild("HumanoidRootPart", 5);
			if (newRoot && newRoot.IsA("BasePart")) {
				humanoidRoot = newRoot;
			}
			cacheCharacterRefs();
			resetCoordinate();
			resetSpring();
		}),
	);

	cacheCharacterRefs();
	resetCoordinate();
}

function cacheCharacterRefs() {
	const character = player.Character;
	if (!character) return;

	const root = character.FindFirstChild("HumanoidRootPart");
	if (root && root.IsA("BasePart")) humanoidRoot = root;

	const hum = character.FindFirstChildWhichIsA("Humanoid");
	if (hum) {
		humanoid = hum;
		if (originalHipHeight === undefined) {
			originalHipHeight = hum.HipHeight;
		}
	}
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

function getUnitDirection(): Vector3 {
	let sum = new Vector3();
	for (const [, v3] of pairs(moveDirection)) {
		sum = sum.add(v3);
	}
	return sum.Magnitude > 0 ? sum.Unit : sum;
}

/**
 * Smooth acceleration/deceleration. Instead of snapping to the target
 * velocity, we lerp toward it. When no input is held, we lerp toward zero
 * which gives that slow drift-to-stop telekinetic feel.
 */
function stepVelocity(deltaTime: number) {
	const camera = Workspace.CurrentCamera!;
	const input = getUnitDirection();

	let targetVelocity = new Vector3();
	if (input.Magnitude > 0) {
		// Build a world-space direction from camera-relative input.
		// W/S is forward/back along the camera's look vector.
		// A/D is left/right along the camera's right vector.
		// Q/E is world up/down.
		const look = camera.CFrame.LookVector;
		const right = camera.CFrame.RightVector;

		const forward = new Vector3(look.X, 0, look.Z).Unit;
		const rightFlat = new Vector3(right.X, 0, right.Z).Unit;

		targetVelocity = forward.mul(input.Z * -1)
			.add(rightFlat.mul(input.X))
			.add(new Vector3(0, -input.Y, 0)); // Q = up (input.Y is -1), E = down
	}

	const rate = input.Magnitude > 0 ? ACCELERATION : DECELERATION;
	const alpha = math.clamp(rate * deltaTime, 0, 1);
	velocity = velocity.Lerp(targetVelocity.mul(speed), alpha);
}

function stepPosition(deltaTime: number) {
	targetPosition = targetPosition.add(velocity.mul(deltaTime));

	// Feed the spring so motion has a tiny bit of organic lag.
	coordinateSpring.setGoal([
		new Spring(targetPosition.X),
		new Spring(targetPosition.Y),
		new Spring(targetPosition.Z),
	]);
	coordinateSpring.step(deltaTime);

	const [x, y, z] = coordinateSpring.getValue();
	targetPosition = new Vector3(x, y, z);
}

// ---------------------------------------------------------------------------
// Pose
// ---------------------------------------------------------------------------

/**
 * Force the character into a "flying" pose:
 *  - Lower HipHeight so the body is level with the ground (crouch-like).
 *  - Play a flying animation on the Animator (loops while flying).
 *  - Disable the default Animate script so it doesn't fight us.
 *
 * This never disables collision — you can still bump into walls and doors.
 */
function applyPose() {
	if (!humanoid || !humanoidRoot) return;

	// Trigger a "crouch" posture by shrinking hip height. The character
	// stays upright in the world, but visually leans forward/flat.
	if (originalHipHeight === undefined) {
		originalHipHeight = humanoid.HipHeight;
	}
	humanoid.HipHeight = originalHipHeight - 1.5;
	humanoid.WalkSpeed = 0;      // stop the default walk controller
	humanoid.JumpPower = 0;
	humanoid.JumpHeight = 0;
	humanoid.UseJumpPower = true;

	// Suspend the default Animate local script so it doesn't override us.
	const animate = humanoid.Parent?.FindFirstChild("Animate");
	if (animate && animate.IsA("BaseScript")) {
		animate.Disabled = true;
	}

	// Play a flying animation.
	const animator = humanoid.FindFirstChildOfClass("Animator");
	if (animator) {
		const anim = new Instance("Animation");
		anim.AnimationId = FLY_ANIMATION_ID;
		flyAnimationTrack = animator.LoadAnimation(anim);
		flyAnimationTrack.Looped = true;
		flyAnimationTrack.Play(0.2);
	}
}

function restorePose() {
	if (humanoid) {
		if (originalHipHeight !== undefined) {
			humanoid.HipHeight = originalHipHeight;
		}
		humanoid.WalkSpeed = 16;
		humanoid.JumpPower = 50;
		humanoid.JumpHeight = 7.2;
		humanoid.UseJumpPower = false;
	}
	if (flyAnimationTrack) {
		flyAnimationTrack.Stop(0.2);
		flyAnimationTrack = undefined;
	}
	const animate = humanoid?.Parent?.FindFirstChild("Animate");
	if (animate && animate.IsA("BaseScript")) {
		animate.Disabled = false;
	}
}

// ---------------------------------------------------------------------------
// Coordinate helpers
// ---------------------------------------------------------------------------

function resetCoordinate() {
	if (!humanoidRoot) return;
	targetPosition = humanoidRoot.Position;
	velocity = new Vector3();
	applyPose();
}

function resetSpring() {
	coordinateSpring = new GroupMotor(
		[targetPosition.X, targetPosition.Y, targetPosition.Z],
		false,
	);
}

function updateDirection(code: Enum.KeyCode, begin: boolean) {
	switch (code) {
		case Enum.KeyCode.W:
			moveDirection.forward = begin ? new Vector3(0, 0, -1) : new Vector3();
			break;
		case Enum.KeyCode.S:
			moveDirection.backward = begin ? new Vector3(0, 0, 1) : new Vector3();
			break;
		case Enum.KeyCode.A:
			moveDirection.left = begin ? new Vector3(-1, 0, 0) : new Vector3();
			break;
		case Enum.KeyCode.D:
			moveDirection.right = begin ? new Vector3(1, 0, 0) : new Vector3();
			break;
		case Enum.KeyCode.Q:
			moveDirection.up = begin ? new Vector3(0, -1, 0) : new Vector3();
			break;
		case Enum.KeyCode.E:
			moveDirection.down = begin ? new Vector3(0, 1, 0) : new Vector3();
			break;
	}
}

function resetDirection() {
	moveDirection.forward = new Vector3();
	moveDirection.backward = new Vector3();
	moveDirection.left = new Vector3();
	moveDirection.right = new Vector3();
	moveDirection.up = new Vector3();
	moveDirection.down = new Vector3();
}

main().catch((err) => {
	warn(`[flight-worker] ${err}`);
});
