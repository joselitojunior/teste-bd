import { api } from "~/utils/api"

export default function Index() {
	const releaseResult = api.database.releaseResult.useMutation().mutateAsync;

	async function handleClick() {
		await releaseResult({week: 1, splitId: 4});
	}

	return (
		<button onClick={handleClick}>Adicionar dados</button>
	)
}
