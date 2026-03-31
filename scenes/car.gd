extends CharacterBody3D

@onready var spring_arm = $SpringArm3D
@onready var cam = $SpringArm3D/Camera3D
@onready var engine_sound = $EngineSound

var speed = 0.0
var max_speed = 35.0
var acceleration = 60.0
var friction = 8.0
var turn_speed = 4.5
var gravity = 30.0

func _physics_process(delta):

	# 🚗 Movement
	if Input.is_action_pressed("accelerate"):
		speed += acceleration * delta
		
		if not engine_sound.playing:
			engine_sound.play()

	elif Input.is_action_pressed("brake"):
		speed -= acceleration * delta

		if engine_sound.playing:
			engine_sound.stop()

	else:
		speed = move_toward(speed, 0, friction * delta)

		if engine_sound.playing:
			engine_sound.stop()

	speed = clamp(speed, -max_speed, max_speed)

	# 🎮 Steering
	var turn = 0.0
	if Input.is_action_pressed("steer_left"):
		turn += 1
	if Input.is_action_pressed("steer_right"):
		turn -= 1

	rotation.y += turn * turn_speed * delta * (speed / max_speed) * 2.0

	# 🚗 Movement forward
	velocity.x = transform.basis.z.x * speed
	velocity.z = transform.basis.z.z * speed

	# 🌍 Gravity
	if not is_on_floor():
		velocity.y -= gravity * delta
	else:
		velocity.y = 0

	move_and_slide()

	# 🎥 Camera always looks at car
	cam.look_at(global_transform.origin)

	# 🔊 Engine pitch
	engine_sound.pitch_scale = 0.8 + (abs(speed) / max_speed)

	# 🌊 Water death
	if global_position.y < 0:
		die()


func die():
	if get_tree().paused:
		return

	get_tree().paused = true

	var ui = get_tree().get_first_node_in_group("death_ui")
	if ui:
		ui.show_death_screen()
