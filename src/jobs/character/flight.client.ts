import { GroupMotor, Spring } from "@rbxts/flipper";
import { Players, RunService, UserInputService, Workspace } from "@rbxts/services";
import { onJobChange, trackCleanup, trackConnection } from "jobs/helpers/job-store";

const player = Players.LocalPlayer;
const moveDirection = {
	forward: new Vector3(),
	backward: new Vector3(),
	left: new Vector3(),
	right: new Vector3(),
	up: new Vector3(),
	down: new Vector3(),
};

// Whether the player is currently flying, the speed in studs per second, and
// the movement direction.
let enabled = false;
let speed = 16;

// The root part and current CFrame. Undefined when there is no character.
let humanoidRoot: BasePart | undefined;
let coordinate: CFrame | undefined;
let coordinateSpring = new GroupMotor([0, 0, 0], false);

// ADDITION: momentum state and flight pose state.
let velocity = new Vector3();
let humanoid: Humanoid | undefined;
let originalHipHeight: number | undefined;
const ACCELERATION = 3.5;
const DECELERATION = 4.5;

async function main() {
	trackCleanup(() => {
		enabled = false;
		humanoidRoot = undefined;
		coordinate = undefined;
		// ADDITION: reset our extra state on cleanup.
		humanoid = undefined;
		velocity = new Vector3();
		resetDirection();
		restorePose();
	});

	await onJobChange("flight", (job) => {
		enabled = job.active;
		speed = job.value;
		if (enabled) {
			// ADDITION: cache character refs so pose can be applied.
			cacheCharacterRefs();
			resetCoordinate();
			resetSpring();
			// ADDITION: apply the flying pose while the job is active.
			applyPose();
		} else {
			// ADDITION: restore the normal pose when the job is inactive.
			restorePose();
		}
	});

	trackConnection(
		UserInputService.InputBegan.Connect((input, gameProcessed) => {
			if (gameProcessed) {
				return;
			}
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
			if (enabled && humanoidRoot && coordinate) {
				// ADDITION: momentum step before advancing the coordinate.
				stepVelocity(deltaTime);
				updateCoordinate(deltaTime);
				coordinateSpring.setGoal([
					new Spring(coordinate.X),
					new Spring(coordinate.Y),
					new Spring(coordinate.Z),
				]);
				coordinateSpring.step(deltaTime);

				const [x, y, z] = coordinateSpring.getValue();
				humanoidRoot.AssemblyLinearVelocity = new Vector3();
				// ADDITION: zero angular velocity too, so physics doesn't fight us.
				humanoidRoot.AssemblyAngularVelocity = new Vector3();
				humanoidRoot.CFrame = Workspace.CurrentCamera!.CFrame.Rotation.add(new Vector3(x, y, z));
			}
		}),
	);

	// Update root part CFrame with the Camera's current direction. May be removed
	// in the future.
	trackConnection(
		RunService.RenderStepped.Connect(() => {
			if (enabled && humanoidRoot && coordinate) {
				humanoidRoot.CFrame = Workspace.CurrentCamera!.CFrame.Rotation.add(humanoidRoot.CFrame.Position);
			}
		}),
	);

	trackConnection(
		player.CharacterAdded.Connect((character) => {
			const newHumanoidRoot = character.WaitForChild("HumanoidRootPart", 5);
			if (newHumanoidRoot && newHumanoidRoot.IsA("BasePart")) {
				humanoidRoot = newHumanoidRoot;
			}
			// ADDITION: refresh cached humanoid and re-apply pose if still flying.
			cacheCharacterRefs();
			resetCoordinate();
			resetSpring();
			if (enabled) {
				applyPose();
			}
		}),
	);

	const currentHumanoidRoot = player.Character?.FindFirstChild("HumanoidRootPart");
	if (currentHumanoidRoot && currentHumanoidRoot.IsA("BasePart")) {
		humanoidRoot = currentHumanoidRoot;
		resetCoordinate();
	}
}

// ADDITION: cache the humanoid reference and remember its original HipHeight.
function cacheCharacterRefs() {
	const character = player.Character;
	if (!character) {
		return;
	}
	const hum = character.FindFirstChildWhichIsA("Humanoid");
	if (hum) {
		humanoid = hum;
		if (originalHipHeight === undefined) {
			originalHipHeight = hum.HipHeight;
		}
	}
}

function getUnitDirection() {
	let sum = new Vector3();
	for (const [, v3] of pairs(moveDirection)) {
		sum = sum.add(v3);
	}
	return sum.Magnitude > 0 ? sum.Unit : sum;
}

function resetCoordinate() {
	if (!humanoidRoot) {
		return;
	}
	const { XVector, YVector, ZVector } = Workspace.CurrentCamera!.CFrame;
	coordinate = CFrame.fromMatrix(humanoidRoot.Position, XVector, YVector, ZVector);
	// ADDITION: also clear momentum on reset.
	velocity = new Vector3();
}

function resetSpring() {
	if (!coordinate) {
		return;
	}
	coordinateSpring = new GroupMotor([coordinate.X, coordinate.Y, coordinate.Z], false);
}

function updateCoordinate(deltaTime: number) {
	if (!coordinate) {
		return;
	}

	const { XVector, YVector, ZVector } = Workspace.CurrentCamera!.CFrame;
	const direction = getUnitDirection();

	if (direction.Magnitude > 0) {
		const { X, Y, Z } = direction.mul(speed * deltaTime);
		coordinate = CFrame.fromMatrix(coordinate.Position, XVector, YVector, ZVector).mul(new CFrame(X, Y, Z));
	} else {
		coordinate = CFrame.fromMatrix(coordinate.Position, XVector, YVector, ZVector);
	}
}

// ADDITION: smooth acceleration/deceleration so movement feels telekinetic.
function stepVelocity(deltaTime: number) {
	const camera = Workspace.CurrentCamera!;
	const input = getUnitDirection();

	let targetVelocity = new Vector3();
	if (input.Magnitude > 0) {
		const look = camera.CFrame.LookVector;
		const right = camera.CFrame.RightVector;
		const forward = new Vector3(look.X, 0, look.Z).Unit;
		const rightFlat = new Vector3(right.X, 0, right.Z).Unit;

		targetVelocity = forward.mul(input.Z * -1)
			.add(rightFlat.mul(input.X))
			.add(new Vector3(0, -input.Y, 0));
	}

	const rate = input.Magnitude > 0 ? ACCELERATION : DECELERATION;
	const alpha = math.clamp(rate * deltaTime, 0, 1);
	velocity = velocity.Lerp(targetVelocity.mul(speed), alpha);
}

// ADDITION: apply the crouch-like flying posture.
function applyPose() {
	if (!humanoid) {
		return;
	}
	if (originalHipHeight === undefined) {
		originalHipHeight = humanoid.HipHeight;
	}
	humanoid.HipHeight = originalHipHeight - 1.5;
	humanoid.WalkSpeed = 0;
	humanoid.JumpPower = 0;
	humanoid.JumpHeight = 0;
	humanoid.UseJumpPower = true;
}

// ADDITION: restore the humanoid's normal posture.
function restorePose() {
	if (humanoid && originalHipHeight !== undefined) {
		humanoid.HipHeight = originalHipHeight;
		humanoid.WalkSpeed = 16;
		humanoid.JumpPower = 50;
		humanoid.JumpHeight = 7.2;
		humanoid.UseJumpPower = false;
	}
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
