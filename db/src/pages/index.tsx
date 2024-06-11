import { useState } from "react";
import { api } from "~/utils/api"

export default function Index() {
	const [state, setState] = useState('Não começou')

	const releaseResult = api.database.releaseResult.useMutation().mutateAsync;

	async function handleClick() {
		setState('Começou')
		const response = await releaseResult({ week: 1, splitId: 4 });
		if (response === 'ok') {
			setState('Deu certo!')
		} else {
			setState('Erro...')
		}
	}

	return (
		<div>
			<button onClick={handleClick}>Adicionar dados</button>
			<p>{state}</p>
		</div>
	)
}
