import { Players, Workspace, UserInputService, RunService } from "@rbxts/services";
import { getStore, isOrcaAlive, onJobChange, trackCleanup, trackPromise } from "jobs/helpers/job-store";
import { JobsAction } from "store/actions/jobs.action";

const player = Players.LocalPlayer;

let currentCharacter: Model | undefined;
let flyConnection: RBXScriptConnection | undefined;
let heartBeatConnection: RBXScriptConnection | undefined;
let bodyVelocity: BodyVelocity | undefined;
let bodyGyro: BodyGyro | undefined;

const FLY_SPEED = 50;
const FLY_ACCELERATION = 10;

async function main() {
	trackCleanup(() => {
		currentCharacter = undefined;
		stopFly();
	});

	function errorHandler(err: unknown) {
		if (!isOrcaAlive()) {
			return;
		}
		warn(`[godmode-worker] ${err}`);
		deactivate();
	}

	await onJobChange("godmode", (job) => {
		if (job.active) {
			activateGodmode().then(deactivateOnCharacterAdded).catch(errorHandler);
		} else {
			stopFly();
		}
	});
}

async function deactivate() {
	if (!isOrcaAlive()) {
		return;
	}
	stopFly();
	const store = await getStore();
	store.dispatch({
		type: "jobs/setJobActive",
		jobName: "godmode",
		active: false,
	} as JobsAction);
}

async function deactivateOnCharacterAdded() {
	await trackPromise(Promise.fromEvent(player.CharacterAdded, (character) => character !== currentCharacter));
	await deactivate();
}

// https://github.com/EdgeIY/infiniteyield/blob/master/source#L9043
async function activateGodmode() {
	const cameraCFrame = Workspace.CurrentCamera!.CFrame;

	const character = player.Character;
	if (!character) {
		throw "Character is null";
	}

	const humanoid = character.FindFirstChildWhichIsA("Humanoid");
	if (!humanoid) {
		throw "No humanoid found";
	}

	const rootPart = character.FindFirstChild("HumanoidRootPart") as BasePart | undefined;
	if (!rootPart) {
		throw "No HumanoidRootPart found";
	}

	const mockHumanoid = humanoid.Clone();
	mockHumanoid.Parent = character;
	currentCharacter = character;

	player.Character = undefined;

	mockHumanoid.SetStateEnabled(Enum.HumanoidStateType.Dead, false);
	mockHumanoid.SetStateEnabled(Enum.HumanoidStateType.Ragdoll, false);
	mockHumanoid.SetStateEnabled(Enum.HumanoidStateType.FallingDown, false);
	mockHumanoid.BreakJointsOnDeath = true;
	mockHumanoid.DisplayDistanceType = Enum.HumanoidDisplayDistanceType.None;
	humanoid.Destroy();

	player.Character = character;
	Workspace.CurrentCamera!.CameraSubject = mockHumanoid;
	task.defer(() => {
		if (isOrcaAlive()) {
			Workspace.CurrentCamera!.CFrame = cameraCFrame;
		}
	});

	const animation = character.FindFirstChild("Animate") as LocalScript | undefined;
	if (animation) {
		animation.Disabled = true;
		animation.Disabled = false;
	}

	// Mark the character as godmode
	mockHumanoid.MaxHealth = math.huge;
	mockHumanoid.Health = mockHumanoid.MaxHealth;

	// Initialize fly
	startFly(rootPart, mockHumanoid);
}

function startFly(rootPart: BasePart, humanoid: Humanoid) {
	// Create BodyVelocity for movement
	bodyVelocity = new Instance("BodyVelocity");
	bodyVelocity.MaxForce = new Vector3(math.huge, math.huge, math.huge);
	bodyVelocity.Velocity = Vector3.zero;
	bodyVelocity.Parent = rootPart;

	// Create BodyGyro for rotation stabilization
	bodyGyro = new Instance("BodyGyro");
	bodyGyro.MaxTorque = new Vector3(math.huge, math.huge, math.huge);
	bodyGyro.P = 10000;
	bodyGyro.D = 1000;
	bodyGyro.CFrame = rootPart.CFrame;
	bodyGyro.Parent = rootPart;

	// Disable gravity and other forces on the character
	rootPart.CustomPhysicalProperties = new PhysicalProperties(0.7, 0.3, 0.5, 100, 100, 100);

	// Main fly loop
	heartBeatConnection = RunService.Heartbeat.Connect((deltaTime) => {
		if (!isOrcaAlive() || !currentCharacter || !bodyVelocity || !bodyGyro) {
			return;
		}

		const camera = Workspace.CurrentCamera!;
		const moveDirection = new Vector3();

		// Get movement input
		const moveVector = humanoid.MoveDirection;
		if (moveVector.Magnitude > 0) {
			moveDirection = moveDirection.add(camera.CFrame.LookVector.mul(moveVector.Z));
			moveDirection = moveDirection.add(camera.CFrame.RightVector.mul(moveVector.X));
		}

		// Vertical movement with Space and Shift/Ctrl
		let verticalDirection = 0;
		if (UserInputService.IsKeyDown(Enum.KeyCode.Space)) {
			verticalDirection = 1;
		} else if (UserInputService.IsKeyDown(Enum.KeyCode.LeftShift) || UserInputService.IsKeyDown(Enum.KeyCode.LeftControl)) {
			verticalDirection = -1;
		}

		// Normalize and apply speed
		if (moveDirection.Magnitude > 0) {
			moveDirection = moveDirection.Unit;
		}
		moveDirection = moveDirection.add(new Vector3(0, verticalDirection, 0));

		// Smoothly interpolate velocity for smoother movement
		const targetVelocity = moveDirection.mul(FLY_SPEED);
		bodyVelocity.Velocity = bodyVelocity.Velocity.Lerp(targetVelocity, FLY_ACCELERATION * deltaTime);

		// Keep the character upright
		bodyGyro.CFrame = new CFrame(rootPart.Position, rootPart.Position.add(camera.CFrame.LookVector));
	});

	// Update camera to follow the character
	const cameraConnection = RunService.RenderStepped.Connect(() => {
		if (!isOrcaAlive() || !currentCharacter) {
			return;
		}
		const camera = Workspace.CurrentCamera!;
		// Ensure camera subject is the root part for proper following
		if (camera.CameraSubject !== rootPart) {
			camera.CameraSubject = rootPart;
		}
	});

	flyConnection = cameraConnection;
}

function stopFly() {
	if (bodyVelocity) {
		bodyVelocity.Destroy();
		bodyVelocity = undefined;
	}
	if (bodyGyro) {
		bodyGyro.Destroy();
		bodyGyro = undefined;
	}
	if (heartBeatConnection) {
		heartBeatConnection.Disconnect();
		heartBeatConnection = undefined;
	}
	if (flyConnection) {
		flyConnection.Disconnect();
		flyConnection = undefined;
	}
}

main().catch((err) => {
	warn(`[godmode-worker] ${err}`);
});
